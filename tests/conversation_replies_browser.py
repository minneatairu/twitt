"""Whole-conversation matching plus explicit migration of started legacy jobs."""
import csv
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page()
    page.on('dialog',lambda d:d.accept())
    calls=[]
    def api(route):
        if route.request.method != 'POST':
            route.fulfill(json={'configured':True});return
        calls.append(route.request.post_data_json)
        route.fulfill(json={'rows':[
            {'id':'900','conversation_id':'100','parent_post_id':'999'},
            {'id':'901','conversation_id':'100','parent_post_id':''}],
            'next_token':None, 'incomplete':False})
    page.route('**/api/index',api)
    page.goto(os.environ.get('APP_BASE_URL','http://127.0.0.1:8012'))
    page.wait_for_function("() => !document.getElementById('prepare-replies').disabled")
    page.locator('#selected-posts-file').set_input_files({'name':'selected.csv','mimeType':'text/csv','buffer':b'id,conversation_id,replies\n100,100,2\n200,100,1\n'})
    page.locator('#prepare-replies').click()
    page.locator('#run-replies').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('collection complete')")
    saved=page.evaluate('() => CollectionStore.loadReplies()')
    assert saved['scope']=='conversation' and len(calls)==1
    assert len(saved['threads'][0]['replies'])==2 and calls[0]['scope']=='conversation'
    with page.expect_download() as download:
        page.locator('#download-combined').click()
    with open(download.value.path(),encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f))
    assert len(rows)==4
    assert [row['reply_parent_post_id'] for row in rows]==['999','','999','']
    page.reload()
    page.wait_for_function("() => !document.getElementById('clear-replies').disabled")
    assert '2 unique replies' in page.locator('#reply-plan').inner_text()
    # Simulate a previously completed direct-only job, with saved matches and an old cursor query.
    page.evaluate("""async () => {
      const s = await CollectionStore.loadReplies();
      s.scope='direct'; s.threads[0].replies=[{id:'902',conversation_id:'100',parent_post_id:'100'}];
      await CollectionStore.saveReplies(s);
    }""")
    page.reload()
    page.wait_for_function("() => !document.getElementById('convert-conversation').hidden")
    page.locator('#convert-conversation').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('Whole-conversation collection prepared')")
    migrated=page.evaluate('() => CollectionStore.loadReplies()')
    assert len(calls)==1 and migrated['scope']=='conversation'
    assert migrated['threads'][0]['replies'][0]['id']=='902'
    assert migrated['batches'][0]['pages']==0 and not migrated['batches'][0]['complete']
    page.locator('#run-replies').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('collection complete')")
    final=page.evaluate('() => CollectionStore.loadReplies()')
    assert len(final['threads'][0]['replies'])==3 and len(calls)==2
    assert calls[-1]['next_token'] is None
    browser.close()
    print('PASS: nested and unknown-parent replies, shared-conversation CSV, reload, legacy conversion retains replies, resets pagination without paid calls.')
