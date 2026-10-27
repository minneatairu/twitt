"""No automatic browser persistence, old-job prompts, or cross-tab merging."""
import json
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    context=browser.new_context()
    calls=[]; dialogs=[]
    def api(route):
        if route.request.method!='POST':
            route.fulfill(json={'configured':True,'google_client_id':''});return
        body=route.request.post_data_json;calls.append(body)
        cid=body['conversation_ids'][0]
        route.fulfill(json={'rows':[{'id':'900','conversation_id':cid,'parent_post_id':cid,'text':'Saved reply'}], 'next_token':None})
    def setup(page):
        page.route('**/api/index',api)
        page.on('dialog',lambda d:(dialogs.append(d.message),d.dismiss()))
        page.goto(os.environ.get('APP_BASE_URL','http://127.0.0.1:8013'))
        page.wait_for_function("() => !document.getElementById('prepare-replies').disabled")
    def upload(page,identifier):
        page.locator('#selected-posts-file').set_input_files({'name':f'{identifier}.csv','mimeType':'text/csv','buffer':f'id,conversation_id,text\n{identifier},{identifier},Original post\n'.encode()})
        page.locator('#prepare-replies').click()
        page.wait_for_function("() => !document.getElementById('reply-controls').hidden")
    page=context.new_page();setup(page)
    # Old browser data exists, but is never read or restored by the app.
    page.evaluate("""() => new Promise((resolve,reject) => {
      const r=indexedDB.open('twitt-collections',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('collections');
      r.onsuccess=()=>{
        const db=r.result;const tx=db.transaction('collections','readwrite');
        tx.objectStore('collections').put({old:'do not restore'},'replies-active');
        tx.objectStore('collections').put({old:'do not restore'},'active');
        tx.oncomplete=()=>{db.close();resolve();};
      };r.onerror=reject;
    })""")
    page.reload();page.wait_for_function("() => !document.getElementById('prepare-replies').disabled")
    assert page.locator('#reply-controls').is_hidden() and dialogs==[] and calls==[]
    upload(page,'100')
    page.locator('#run-replies').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('collection complete')")
    with page.expect_download() as result:page.locator('#download-reply-checkpoint').click()
    checkpoint=open(result.value.path(),encoding='utf-8').read()
    assert json.loads(checkpoint)['threads'][0]['replies'][0]['id']=='900'
    second=context.new_page();setup(second)
    assert second.locator('#reply-controls').is_hidden()
    upload(second,'200')
    assert '100' == page.evaluate('async () => (await CollectionStore.loadReplies()).posts[0].id')
    assert '200' == second.evaluate('async () => (await CollectionStore.loadReplies()).posts[0].id')
    # Replacing the explicitly selected session file needs no old-job merge popup.
    upload(page,'300')
    page.wait_for_function("async () => (await CollectionStore.loadReplies()).posts[0].id === '300'")
    assert dialogs==[] and len(calls)==1
    page.reload();page.wait_for_function("() => !document.getElementById('prepare-replies').disabled")
    assert page.locator('#reply-controls').is_hidden()
    assert page.evaluate('() => CollectionStore.loadReplies()') is None
    assert page.evaluate('() => CollectionStore.load()') is None
    assert page.locator('#selected-posts-file').input_value()==''
    # Resuming is possible only through the user's explicit checkpoint import.
    page.locator('#reply-checkpoint-file').set_input_files({'name':'saved.json','mimeType':'application/json','buffer':checkpoint.encode()})
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('Checkpoint restored')")
    assert len(calls)==1 and dialogs==[]
    with page.expect_download() as exported:page.locator('#download-combined').click()
    assert 'Saved reply' in open(exported.value.path(),encoding='utf-8-sig').read()
    page.locator('#clear-replies').click()
    page.wait_for_function("() => document.getElementById('reply-controls').hidden")
    assert dialogs==[]
    # Old saved data was left untouched rather than silently deleted.
    assert page.evaluate("""() => new Promise(resolve=>{const r=indexedDB.open('twitt-collections',1);r.onsuccess=()=>{const db=r.result;const q=db.transaction('collections').objectStore('collections').get('replies-active');q.onsuccess=()=>{resolve(q.result.old);db.close();};};})""")=='do not restore'
    browser.close()
    print('PASS: old saved jobs ignored, reload starts empty, tabs isolated, replacement has no prompts, explicit checkpoint resume works, no automatic X calls.')
