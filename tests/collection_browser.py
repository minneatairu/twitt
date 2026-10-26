"""Four-month collection workflow with simulated X and Google APIs; no live credits used."""
import csv
import io
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1280, 'height': 1100})
    errors, searches, creates, writes = [], [], [], []
    settings = {'fail_write': False, 'google': True, 'fail_at': None}
    page.on('pageerror', lambda error: errors.append(str(error)))

    def app_api(route):
        if route.request.method == 'GET':
            return route.fulfill(json={'ok': True, 'configured': True,
                'google_client_id': 'test-public.apps.googleusercontent.com' if settings['google'] else ''})
        data = route.request.post_data_json
        searches.append(data)
        assert data['query'] == '#climate', 'Collection title must never enter the X query'
        assert data['start'] == data['end']
        count = data['count']
        start = int(data['next_token']) if data.get('next_token') else 0
        rows = [{'id': data['start'] + '-' + str(i), 'month': data['start'], 'language': 'en',
                 'text': '=SUM(1,2)\nLiteral post text', 'url': 'https://x.com/i/web/status/123',
                 'username': 'tester', 'created_at': data['start'] + '-01T00:00:00Z',
                 'likes': i, 'reposts': 2, 'replies': 3, 'quotes': 4,
                 'author_followers': 20, 'author_name': 'Test', 'author_verified': True,
                 'bookmarks': 99, 'geo': '{}', 'raw_json': '{}', 'impressions': 99,
                 'media': '[{"type":"photo","url":"https://pbs.twimg.com/media/example.jpg","alt_text":"Post image"}]',
                 'images': '["https://pbs.twimg.com/media/example.jpg"]'} for i in range(start, start + count)]
        return route.fulfill(json={'rows': rows, 'next_token': str(start + count) if start + count < 500 else None,
                                  'end_time': '2024-05-01T00:00:00Z'})

    page.route('**/api/index', app_api)
    page.route('https://accounts.google.com/gsi/client', lambda route: route.fulfill(
        content_type='application/javascript', body="""
        window.google = {accounts: {oauth2: {initTokenClient(config) {
          window.testScope = config.scope;
          return {requestAccessToken() {
            config.callback(window.denyGoogle ? {error:'access_denied'} : {access_token:'test-only-google-token'});
          }};
        }}}};
        """))
    import base64
    page.route('https://pbs.twimg.com/**', lambda route: route.fulfill(content_type='image/png',
        body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')))

    def google_api(route):
        assert route.request.headers['authorization'] == 'Bearer test-only-google-token'
        body = route.request.post_data_json
        if route.request.method == 'POST':
            creates.append(body)
            return route.fulfill(json={'spreadsheetId': 'collection-sheet-' + str(len(creates))})
        writes.append({'url': route.request.url, 'body': body})
        if settings['fail_write'] or (settings['fail_at'] and settings['fail_at'] in route.request.url):
            settings['fail_write'] = False
            settings['fail_at'] = None
            return route.fulfill(status=429, json={'error': {'message': 'rate limited'}})
        return route.fulfill(json={'updatedRows': len(body['values'])})

    page.route('https://sheets.googleapis.com/**', google_api)
    base = os.environ.get('APP_BASE_URL', 'http://127.0.0.1:8000')
    page.goto(base)
    page.wait_for_function('() => !document.querySelector("#submit").disabled')
    assert page.locator('#post-limit').input_value() == '5'
    assert page.locator('.month-slot').count() == 4
    page.fill('#collection-title', 'Climate research collection')
    page.fill('#query', '#climate')
    months = ['2024-01', '2024-02', '2024-03', '2024-04']
    for i, month in enumerate(months):
        page.fill('#month-' + str(i), month)
    assert page.locator('[data-slot="0"]').is_enabled()
    assert 'Save month slot 1 first' in page.locator('#slot-status-1').inner_text()
    page.fill('#month-1', months[0])
    page.click('#submit')
    assert 'distinct months' in page.locator('#status').inner_text()
    assert len(searches) == 0 and len(creates) == 0
    page.fill('#month-1', months[1])
    page.click('#submit')
    page.wait_for_function('async () => Boolean(await CollectionStore.load())')
    assert page.locator('#collection-title').is_enabled()
    assert page.locator('#query').is_enabled()
    page.fill('#collection-title', '')
    page.fill('#query', '')
    assert page.locator('#collection-title').is_enabled() and page.locator('#query').is_enabled()
    page.fill('#collection-title', 'Draft collection title')
    page.fill('#query', '#climate OR #wind')
    assert 'Apply collection settings' in page.locator('#submit').inner_text()
    page.click('#submit')
    page.wait_for_function('async () => (await CollectionStore.load()).title === "Draft collection title"')
    assert len(searches) == 0 and len(creates) == 0
    page.fill('#collection-title', 'Climate research collection')
    page.fill('#query', '#climate')
    page.click('#submit')
    page.wait_for_function('async () => (await CollectionStore.load()).title === "Climate research collection"')
    assert all(page.locator('#month-' + str(i)).is_enabled() for i in range(4))
    # Starting the collection does not freeze dates that have not been searched.
    page.fill('#month-3', '2024-05')
    page.locator('#month-3').blur()
    page.wait_for_function('async () => (await CollectionStore.load()).slots[3].month === "2024-05"')
    page.wait_for_function('() => !document.querySelector("#month-3").disabled')
    page.fill('#month-3', '')
    page.locator('#month-3').blur()
    page.wait_for_function('async () => (await CollectionStore.load()).slots[3].month === ""')
    assert len(searches) == 0 and len(creates) == 0
    assert page.locator('[data-slot="1"]').is_disabled()

    # Declining Google must not consume any X searches or mark a month as saved.
    page.evaluate('window.denyGoogle = true')
    page.click('[data-slot="0"]')
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("failed")')
    assert len(searches) == 0 and len(creates) == 0
    page.evaluate('window.denyGoogle = false')
    page.click('[data-slot="0"]')
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("saved")')
    assert len(searches) == 1 and searches[0]['count'] == 10
    assert len(creates) == 1
    assert creates[0]['properties']['title'] == 'Climate research collection'
    assert creates[0]['sheets'][0]['properties']['gridProperties']['rowCount'] == 2001
    header = writes[0]['body']['values'][0]
    assert header[0] == 'collection_title'
    assert header[header.index('quotes') + 1] == 'engagement'
    assert all(row[header.index('engagement')] == '' for row in writes[1]['body']['values'])
    assert {'geo','impressions','raw_json','language','engagement_score','author_name','author_verified','author_followers','bookmarks'}.isdisjoint(header)
    assert 'valueInputOption=RAW' in writes[1]['url']
    assert writes[1]['body']['values'][0][header.index('text')] == '=SUM(1,2)\nLiteral post text'
    assert writes[1]['body']['values'][0][0] == 'Climate research collection'
    assert page.locator('#gallery img').first.get_attribute('alt') == 'Post image'
    assert page.locator('[data-slot="0"]').is_disabled()
    assert page.locator('#month-0').is_disabled()
    assert page.locator('#month-1').is_enabled()
    assert page.locator('#month-2').is_enabled()
    # Editing a started query is allowed, but it cannot silently change the existing dataset.
    page.fill('#query', '#different-research-query')
    assert 'Start new collection' in page.locator('#submit').inner_text()
    assert page.locator('[data-slot="1"]').is_disabled()
    page.once('dialog', lambda dialog: dialog.dismiss())
    page.click('#submit')
    assert page.evaluate('async () => (await CollectionStore.load()).query') == '#climate'
    assert len(searches) == 1 and len(creates) == 1
    page.fill('#query', '#climate')
    assert page.locator('[data-slot="1"]').is_enabled()

    # A failed write stays non-green; retry uses the same sheet/range without another search.
    settings['fail_write'] = True
    page.click('[data-slot="1"]')
    page.wait_for_function('() => document.querySelector("#slot-1").classList.contains("failed")')
    assert not page.locator('#slot-1').evaluate('(el) => el.classList.contains("saved")')
    assert page.locator('[data-slot="2"]').is_disabled()
    before = len(searches)
    failed = writes[-1]
    assert 'A7' in failed['url']
    page.click('[data-slot="1"]')
    page.wait_for_function('() => document.querySelector("#slot-1").classList.contains("saved")')
    assert len(searches) == before and len(creates) == 1
    assert writes[-1] == failed

    # Browser reload restores statuses, collected rows, and the shared spreadsheet ID.
    page.reload()
    page.wait_for_function('() => document.querySelector("#slot-1").classList.contains("saved")')
    assert page.locator('#collection-title').input_value() == 'Climate research collection'
    assert page.locator('#open-sheet').get_attribute('href').endswith('/collection-sheet-1/edit')
    assert page.locator('#month-0').is_disabled() and page.locator('#month-1').is_disabled()
    assert page.locator('#month-3').is_enabled()
    before = len(searches)
    page.fill('#month-3', '2024-04')
    page.locator('#month-3').blur()
    page.wait_for_function('async () => (await CollectionStore.load()).slots[3].month === "2024-04"')
    assert len(searches) == before and len(creates) == 1
    for i in (2, 3):
        page.click(f'[data-slot="{i}"]')
        page.wait_for_function(f'() => document.querySelector("#slot-{i}").classList.contains("saved")')
    assert len(searches) == 4 and len(creates) == 1
    assert all('collection-sheet-1' in write['url'] for write in writes)
    assert sum(1 for write in writes if 'A1?' in write['url']) == 1
    assert 'Collection complete: 20 posts' in page.locator('#status').inner_text()
    with page.expect_download() as downloaded:
        page.click('#download')
    rows = list(csv.DictReader(io.StringIO(open(downloaded.value.path(), encoding='utf-8-sig').read())))
    assert len(rows) == 20
    assert [row['month'] for row in rows] == [month for month in months for _ in range(5)]
    assert [row['id'] for row in rows] == [month + '-' + str(i) for month in months for i in range(5)]
    assert {row['collection_title'] for row in rows} == {'Climate research collection'}
    assert 'engagement_score' not in rows[0]
    assert list(rows[0])[list(rows[0]).index('quotes') + 1] == 'engagement'
    assert all(row['engagement'] == '' for row in rows)
    stored = page.evaluate('async () => JSON.stringify(await CollectionStore.load())')
    assert 'test-only-google-token' not in stored
    page.screenshot(path='/tmp/twitt-four-months.png', full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

    # New collections are separate files; a partial batch resumes after reload without X refetch.
    page.on('dialog', lambda dialog: dialog.accept())
    page.click('#new-collection')
    page.fill('#collection-title', 'Second research collection')
    page.select_option('#post-limit', '500')
    for i in (1,2,3): page.fill('#month-' + str(i), '')
    # Direct month click starts the collection without the separate Start collection step.
    assert page.locator('[data-slot="0"]').is_enabled()
    settings['fail_at'] = 'A102?'
    page.click('[data-slot="0"]')
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("failed")')
    assert len(creates) == 2
    assert len(searches) == 9  # four small searches plus five pages of 100
    failed = writes[-1]
    assert 'A102?' in failed['url']
    page.reload()
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("failed")')
    before = len(searches)
    page.click('[data-slot="0"]')
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("saved")')
    assert len(searches) == before and len(creates) == 2
    repeated = [write for write in writes if write['url'] == failed['url']]
    assert len(repeated) == 2 and repeated[0] == repeated[1]
    assert page.locator('#gallery .post').count() == 24
    page.click('#more')
    assert page.locator('#gallery .post').count() == 48
    # Missing Sheets configuration is explained on click rather than silently disabling all months.
    page.click('#new-collection')
    settings['google'] = False
    page.reload()
    page.wait_for_function('() => !document.querySelector("#submit").disabled')
    page.fill('#collection-title', 'Configuration check')
    page.fill('#query', '#climate')
    before = len(searches)
    page.click('[data-slot="0"]')
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("failed")')
    assert 'GOOGLE_CLIENT_ID' in page.locator('#slot-status-0').inner_text()
    assert len(searches) == before
    # Continuing a spreadsheet created before this column keeps its old horizontal layout.
    legacy_columns = page.evaluate('''async () => {
      const legacy = {title: "Legacy", sheet: {id: "legacy-sheet", headerWritten: true, nextRow: 2}};
      const slot = {rows: [{quotes: 4, likes: 3, id: "123", engagement: 99}], uploaded: 0, sheetStart: null, month: "2024-01"};
      await TwittSheets.writeMonth(legacy, slot, ["id", "likes", "quotes", "engagement", "images"], "test-only-google-token", async () => {}, () => {});
      return legacy.sheet.columns;
    }''')
    assert legacy_columns == ['id', 'likes', 'quotes', 'images']
    assert writes[-1]['body']['values'][0] == ['123', '3', '4', '']
    assert not errors, errors
    browser.close()
    print('Collection browser checks passed: four editable month slots, saved dates protected, title separate from query, one shared sheet, green only after save, no X refetch on retry, reload recovery, CSV order, excluded columns/bookmarks, images, batching, mobile.')
