"""Optional Playwright checks; run against the local app. All external calls are mocked."""
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1280, 'height': 1000})
    errors, searches, creates, writes = [], [], [], []
    settings = {'configured': True, 'fail_write': False}
    page.on('pageerror', lambda error: errors.append(str(error)))

    def app_api(route):
        if route.request.method == 'GET':
            return route.fulfill(json={'ok': True, 'configured': True,
                'google_client_id': 'public-test.apps.googleusercontent.com' if settings['configured'] else ''})
        data = route.request.post_data_json
        searches.append(data)
        count = min(data['candidates'], 100)
        start = 100 if data.get('next_token') else 0
        count = 5 if start else count
        rows = [{'id': str(1234567890123456789 + i), 'month': data['start'], 'language': 'en',
                 'text': '=SUM(1,2)\nEnglish post', 'url': 'https://x.com/i/web/status/1',
                 'username': 'tester', 'created_at': '2024-01-01T00:00:00Z',
                 'likes': i, 'media': '[]', 'images': '["https://pbs.twimg.com/media/test.jpg"]'}
                for i in range(start, start + count)]
        return route.fulfill(json={'rows': rows, 'next_token': 'second' if data['candidates'] == 500 and not start else None})

    page.route('**/api/index', app_api)
    page.route('https://accounts.google.com/gsi/client', lambda route: route.fulfill(
        content_type='application/javascript', body="""
        window.google = {accounts: {oauth2: {initTokenClient(config) {
          window.testGoogleScope = config.scope;
          window.testGoogleClient = config.client_id;
          return {requestAccessToken() {
            if (window.testDenyGoogle) config.callback({error: 'access_denied'});
            else config.callback({access_token: 'test-only-google-token'});
          }};
        }}}};
        """))

    def sheets_api(route):
        assert route.request.headers['authorization'] == 'Bearer test-only-google-token'
        body = route.request.post_data_json
        if route.request.method == 'POST':
            creates.append(body)
            return route.fulfill(json={'spreadsheetId': 'test-sheet-' + str(len(creates))})
        writes.append({'url': route.request.url, 'body': body})
        if settings['fail_write']:
            settings['fail_write'] = False
            return route.fulfill(status=429, json={'error': {'message': 'rate limited'}})
        return route.fulfill(json={'updatedRows': len(body['values'])})

    page.route('https://sheets.googleapis.com/**', sheets_api)
    base = os.environ.get('APP_BASE_URL', 'http://127.0.0.1:8000')
    page.goto(base)
    assert not page.locator('#send-sheets').is_visible()
    page.fill('#query', '#climate')
    page.fill('#start', '2024-01')
    page.fill('#end', '2024-01')
    page.click('#submit')
    page.locator('#send-sheets').wait_for(state='visible')
    before = len(searches)
    page.click('#send-sheets')
    page.wait_for_function("() => document.querySelector('#sheets-status').textContent.includes('Saved 5 posts')")
    assert len(searches) == before, 'Sheets export must not search X again'
    assert len(creates) == 1 and len(writes) == 1
    assert page.evaluate('window.testGoogleScope') == 'https://www.googleapis.com/auth/drive.file'
    assert page.evaluate('window.testGoogleClient') == 'public-test.apps.googleusercontent.com'
    assert 'valueInputOption=RAW' in writes[0]['url']
    values = writes[0]['body']['values']
    assert len(values) == 6
    assert 'engagement_score' not in values[0]
    assert [row[values[0].index('id')] for row in values[1:]] == [str(1234567890123456789 + i) for i in range(5)]
    assert values[1][values[0].index('id')] == '1234567890123456789'
    assert values[1][values[0].index('text')] == '=SUM(1,2)\nEnglish post'
    assert values[1][values[0].index('images')] == '["https://pbs.twimg.com/media/test.jpg"]'
    assert page.locator('#send-sheets').is_disabled()
    assert page.locator('#open-sheet').get_attribute('href') == 'https://docs.google.com/spreadsheets/d/test-sheet-1/edit'
    assert page.evaluate('localStorage.length') == 0

    # A new search clears the old destination; authorization denial does not create a file.
    page.select_option('#post-limit', '500')
    page.click('#submit')
    page.locator('#send-sheets').wait_for(state='visible')
    assert not page.locator('#open-sheet').is_visible()
    page.evaluate('window.testDenyGoogle = true')
    page.click('#send-sheets')
    page.wait_for_function("() => document.querySelector('#sheets-status').textContent.includes('declined')")
    assert len(creates) == 1
    assert page.locator('#download').is_visible()
    page.evaluate('window.testDenyGoogle = false')

    # A failed batch can resume with the same file and same cell range, without duplicate append.
    before = len(searches)
    settings['fail_write'] = True
    page.click('#send-sheets')
    page.wait_for_function("() => document.querySelector('#send-sheets').textContent.includes('Resume')")
    assert len(creates) == 2
    failed = writes[-1]
    page.click('#send-sheets')
    page.wait_for_function("() => document.querySelector('#sheets-status').textContent.includes('Saved 105 posts')")
    assert len(creates) == 2
    assert writes[-2]['url'] == failed['url']
    assert writes[-2]['body'] == failed['body']
    assert len(writes[-1]['body']['values']) == 6
    assert 'A101' in writes[-1]['url']
    assert len(searches) == before
    page.screenshot(path='/tmp/twitt-sheets.png', full_page=True)

    # Unconfigured deployments explain setup while leaving CSV usable.
    settings['configured'] = False
    page.reload()
    page.fill('#query', '#climate')
    page.fill('#start', '2024-01')
    page.fill('#end', '2024-01')
    page.click('#submit')
    page.locator('#send-sheets').wait_for(state='visible')
    assert page.locator('#send-sheets').is_disabled()
    assert 'GOOGLE_CLIENT_ID' in page.locator('#sheets-status').inner_text()
    assert page.locator('#download').is_visible()
    assert not errors, errors
    browser.close()
    print('Sheets browser checks passed: authorization, RAW cells/IDs, images, no X refetch, batches, resumable writes, denial, missing configuration. Simulated services.')
