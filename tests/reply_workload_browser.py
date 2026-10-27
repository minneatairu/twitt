"""Exercise reported counts, opt-in skips, shared conversations, and saved plans without X calls."""
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page()
    calls = []
    def api(route):
        if route.request.method != 'POST':
            route.fulfill(json={'configured': True})
            return
        body = route.request.post_data_json
        calls.append(body)
        route.fulfill(json={'rows': [
            {'id':'900', 'parent_post_id':'100', 'conversation_id':'100'},
            {'id':'901', 'parent_post_id':'200', 'conversation_id':'100'},
            {'id':'902', 'parent_post_id':'300', 'conversation_id':'300'}], 'next_token':None})
    page.route('**/api/index', api)
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(os.environ.get('APP_BASE_URL', 'http://127.0.0.1:8012'))
    page.wait_for_function("() => !document.getElementById('prepare-replies').disabled")
    source = b'id,conversation_id,replies\n100,100,0\n200,100,10\n300,300,\n400,400,invalid\n500,500,0\n'
    def upload(data):
        page.locator('#selected-posts-file').set_input_files({'name':'selected.csv','mimeType':'text/csv','buffer':data})
        page.locator('#prepare-replies').click()
        page.wait_for_function("() => !document.getElementById('reply-controls').hidden")
    page.locator('#skip-zero-replies').check()
    upload(source)
    plan = page.locator('#reply-plan').inner_text()
    assert 'Reported replies total: 10' in plan and '2 with unknown' in plan
    assert '2 posts skipped' in plan and 'minimum 1 more API calls' in plan
    assert calls == []
    saved = page.evaluate('() => CollectionStore.loadReplies()')
    assert saved['batches'][0]['ids'] == ['100','300','400']
    page.reload()
    page.wait_for_function("() => !document.getElementById('run-replies').disabled")
    assert '2 posts skipped' in page.locator('#reply-plan').inner_text()
    page.locator('#run-replies').click()
    page.wait_for_function("() => document.getElementById('reply-plan').textContent.includes('1 calls attempted') && document.getElementById('run-replies').disabled && !document.getElementById('clear-replies').disabled")
    saved = page.evaluate('() => CollectionStore.loadReplies()')
    assert len(calls) == 1
    assert [reply['id'] for thread in saved['threads'] for reply in thread['replies']] == ['900','901','902']
    assert 'skipped_zero_reported_replies' in page.locator('#reply-summary').inner_text()
    with page.expect_download() as download:
        page.locator('#download-combined').click()
    text = open(download.value.path(), encoding='utf-8-sig').read()
    assert 'reply_collection_status' not in text
    assert 'skipped_zero_reported_replies' in page.locator('#reply-summary').inner_text()
    page.reload()
    page.wait_for_function("() => !document.getElementById('clear-replies').disabled")
    assert 'minimum 0 more API calls' in page.locator('#reply-plan').inner_text()
    page.locator('#clear-replies').click()
    page.wait_for_function("() => document.getElementById('reply-controls').hidden")
    page.locator('#skip-zero-replies').check()
    upload(b'id,conversation_id,replies\n100,100,0\n')
    assert page.locator('#run-replies').is_disabled()
    page.reload()
    page.wait_for_function("() => !document.getElementById('clear-replies').disabled")
    assert 'minimum 0 more API calls' in page.locator('#reply-plan').inner_text()
    assert len(calls) == 1
    page.locator('#clear-replies').click()
    page.wait_for_function("() => document.getElementById('reply-controls').hidden")
    upload(source)
    saved = page.evaluate('() => CollectionStore.loadReplies()')
    assert saved['skipZeroReplies'] is False
    assert saved['batches'][0]['ids'] == ['100','300','400','500']
    assert '0 posts skipped' in page.locator('#reply-plan').inner_text()
    browser.close()
    print('PASS: counts, explicit skips, unknown counts, shared parent matching, CSV, reload, all-zero and default search-all.')
