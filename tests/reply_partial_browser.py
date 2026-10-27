"""Save verified partial-page replies, restore safely, and deduplicate the same-page retry."""
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page()
    calls = []
    def api(route):
        if route.request.method != 'POST':
            route.fulfill(json={'configured':True}); return
        body = route.request.post_data_json
        calls.append(body)
        rows = [{'id':'900','conversation_id':'100','parent_post_id':'100'}]
        if len(calls) == 1:
            route.fulfill(json={'rows':rows, 'next_token':None, 'incomplete':True,
                                'unresolved_count':1, 'warning':'referenced_tweets unresolved'})
        else:
            rows.append({'id':'901','conversation_id':'100','parent_post_id':'100'})
            route.fulfill(json={'rows':rows,'next_token':None,'incomplete':False})
    page.route('**/api/index',api)
    page.goto(os.environ.get('APP_BASE_URL','http://127.0.0.1:8012'))
    page.wait_for_function("() => !document.getElementById('prepare-replies').disabled")
    page.locator('#selected-posts-file').set_input_files({'name':'selected.csv','mimeType':'text/csv','buffer':b'id,conversation_id,replies\n100,100,2\n'})
    page.locator('#prepare-replies').click()
    page.locator('#run-replies').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('Verified replies have been saved')")
    saved = page.evaluate('() => CollectionStore.loadReplies()')
    assert saved['batches'][0]['cursor'] is None and saved['batches'][0]['pages'] == 0
    assert not saved['batches'][0]['complete']
    assert len(saved['threads'][0]['replies']) == 1
    assert saved['status'] == 'paused_incomplete'
    page.reload()
    page.wait_for_function("() => !document.getElementById('run-replies').disabled")
    assert len(calls) == 1
    page.locator('#run-replies').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('collection complete')")
    saved = page.evaluate('() => CollectionStore.loadReplies()')
    assert [row['id'] for row in saved['threads'][0]['replies']] == ['900','901']
    assert saved['batches'][0]['complete'] and saved['batches'][0]['pages'] == 1
    assert len(calls) == 2 and all(call['next_token'] is None for call in calls)
    browser.close()
    print('PASS: partial matches persisted, cursor retained across reload, no automatic retry, same-page retry deduplicated.')
