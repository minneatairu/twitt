"""Import failures are visible beside the button; replies do not require Google."""
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page()
    calls = []
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def api(route):
        if route.request.method == 'GET':
            return route.fulfill(json={'configured': True, 'google_client_id': ''})
        calls.append(route.request.post_data_json)
        return route.fulfill(json={'rows': [], 'next_token': None})
    page.route('**/api/index', api)
    page.goto(os.environ.get('APP_BASE_URL', 'http://127.0.0.1:8000'))
    page.wait_for_function('() => !document.getElementById("prepare-replies").disabled')
    assert page.locator('#reporting-options').is_hidden()
    assert page.locator('#reply-start').input_value() == '2022-04-01'
    page.click('#prepare-replies')
    assert 'Choose your selected-posts CSV' in page.locator('#reply-import-status').inner_text()
    def upload(data):
        page.locator('#selected-posts-file').set_input_files({'name': 'posts.csv', 'mimeType': 'text/csv', 'buffer': data})
    upload(b'id,text\n100,Missing conversation\n')
    page.wait_for_function('() => document.getElementById("reply-import-status").textContent.includes("conversation_id")')
    page.click('#prepare-replies')
    page.wait_for_function('() => document.getElementById("reply-import-status").textContent.includes("conversation_id")')
    assert page.locator('#reply-controls').is_hidden()
    upload(b'id,conversation_id,created_at,text\n100,100,2022-04-21T00:00:00Z,Selected post\n')
    assert page.locator('#reply-start').input_value() == '2022-04-01', 'CSV dates must not replace the default'
    page.fill('#reply-start', '2024-02-01')
    page.fill('#reply-end', '2024-01-01')
    page.click('#prepare-replies')
    page.wait_for_function('() => document.getElementById("reply-import-status").textContent.includes("valid UTC reply date range")')
    page.fill('#reply-start', '2022-04-01')
    page.click('#prepare-replies')
    page.wait_for_function('() => document.getElementById("reply-import-status").textContent.includes("Loaded 1 selected posts")')
    assert page.locator('#run-replies').is_visible() and page.locator('#run-replies').is_enabled()
    assert not calls, 'Import must not use X allowance'
    page.click('#run-replies')
    page.wait_for_function('() => document.getElementById("reply-status").textContent.includes("collection complete")')
    assert len(calls) == 1
    assert not errors, errors
    browser.close()
    print('PASS: missing CSV, invalid CSV, invalid dates show inline errors; valid import exposes reply controls; replies run without Google/reporting.')
