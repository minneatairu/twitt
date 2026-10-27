"""Reply export naming, Google Sheets snapshot retries, restore, and no X calls."""
import csv
import os
from playwright.sync_api import sync_playwright
from browser_helpers import reload_with_checkpoint
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page=browser.new_page()
    page.add_init_script("window.google={accounts:{oauth2:{initTokenClient: options => ({requestAccessToken: () => options.callback({access_token:'test-only-token'})})}}};")
    page.route('https://accounts.google.com/gsi/client',lambda r:r.fulfill(content_type='application/javascript',body=''))
    xcalls=[]; creates=[]; writes=[]; updates=[]; fail={'next':True}
    def api(route):
        if route.request.method=='POST':
            xcalls.append(route.request.post_data_json)
            route.fulfill(json={'rows':[],'next_token':None});return
        route.fulfill(json={'configured':True,'google_client_id':'test-client'})
    def sheets(route):
        request=route.request
        if request.url=='https://sheets.googleapis.com/v4/spreadsheets':
            creates.append(request.post_data_json)
            route.fulfill(json={'spreadsheetId':'reply-file-123'})
        elif request.method=='PUT':
            writes.append(request.post_data_json)
            if fail['next']:
                fail['next']=False;route.fulfill(status=503,json={});return
            route.fulfill(json={})
        else:
            updates.append(request.post_data_json)
            route.fulfill(json={})
    page.route('**/api/index',api)
    page.route('https://sheets.googleapis.com/**',sheets)
    page.goto(os.environ.get('APP_BASE_URL','http://127.0.0.1:8013'))
    page.wait_for_function("() => !document.getElementById('prepare-replies').disabled")
    page.locator('#selected-posts-file').set_input_files({'name':'Research April.csv','mimeType':'text/csv','buffer':b'id,conversation_id,text,engagement,month,hashtags\n100,100,=literal,42,2024-04,#research\n'})
    page.locator('#prepare-replies').click()
    page.wait_for_function("() => !document.getElementById('reply-controls').hidden")
    # Saved results can be re-exported without any new X calls.
    page.evaluate("""async () => {
      const s=await CollectionStore.loadReplies();
      s.threads[0].replies=[{id:'900',conversation_id:'100',parent_post_id:'100',text:'=reply'}];
      await CollectionStore.saveReplies(s);
    }""")
    reload_with_checkpoint(page)
    page.wait_for_function("() => !document.getElementById('download-combined').closest('#reply-controls').hidden")
    with page.expect_download() as result:
        page.locator('#download-combined').click()
    assert result.value.suggested_filename=='Replies_Research April.csv'
    with open(result.value.path(),encoding='utf-8-sig',newline='') as f: csvrows=list(csv.reader(f))
    assert csvrows[0][csvrows[0].index('text')+1]=='reply_text'
    assert not any(name in csvrows[0] for name in ['reply_id','reply_post_type','reply_created_at','reply_author_id','reply_username','reply_conversation_id','reply_parent_post_id','reply_conversation_selected_post_ids','month','hashtags','hashtag','reply_images','reply_likes','reply_window_start','reply_window_end','reply_collected_count','reply_collection_status'])
    page.locator('#save-replies-drive').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('HTTP 503')")
    assert len(creates)==1 and creates[0]['properties']['title']=='Replies_Research April'
    saved=page.evaluate('() => CollectionStore.loadReplies()')
    assert saved['replySheet']['id']=='reply-file-123'
    reload_with_checkpoint(page)
    page.wait_for_function("() => !document.getElementById('save-replies-drive').disabled")
    with page.expect_download() as restored:
        page.locator('#download-combined').click()
    assert restored.value.suggested_filename=='Replies_Research April.csv'
    page.locator('#save-replies-drive').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('Saved Replies_Research April')")
    assert len(creates)==1 and writes[-1]['values'][0]==csvrows[0]
    assert writes[-1]['values'][1][2]=='=literal' # RAW text in Sheets, escaped in CSV
    assert page.locator('#open-replies-sheet').get_attribute('href')=='https://docs.google.com/spreadsheets/d/reply-file-123/edit'
    page.locator('#save-replies-drive').click()
    page.wait_for_function("() => !document.getElementById('save-replies-drive').disabled")
    assert len(creates)==1 and xcalls==[]
    assert any('updateCells' in operation for update in updates for operation in update.get('requests',[]))
    # Alternate uploaded text heading is placed beside reply text, with values aligned.
    page.on('dialog',lambda dialog:dialog.accept())
    page.locator('#selected-posts-file').set_input_files({'name':'Tweets.csv','mimeType':'text/csv','buffer':b'id,conversation_id,tweet,engagement\n100,100,original tweet,42\n'})
    page.locator('#prepare-replies').click()
    page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('Imported')")
    with page.expect_download() as alternate:
        page.locator('#download-combined').click()
    with open(alternate.value.path(),encoding='utf-8-sig',newline='') as f: alternate_rows=list(csv.reader(f))
    headings=alternate_rows[0]
    assert len(alternate_rows)==1
    assert headings[headings.index('tweet')+1]=='reply_text'
    saved=page.evaluate('() => CollectionStore.loadReplies()')
    assert saved['posts'][0]['values'][2:] == ['original tweet','42']
    browser.close()
    print('PASS: original filename survives reload; CSV and Drive schemas match; retry updates same file; literal values preserved; no X calls.')
