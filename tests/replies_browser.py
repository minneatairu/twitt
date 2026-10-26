"""Simulated X replies workflow, including >500 replies, quotas, transfer, and cursor recovery."""
import csv
import io
import json
import os
import time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    calls, errors = [], []
    flags = {'rate_done': False, 'usage_done': False}
    selected = io.StringIO(newline='')
    writer = csv.writer(selected)
    writer.writerow(['id','conversation_id','text','engagement','created_at'])
    writer.writerow(['100','100','Selected root, with comma\nand newline','42.5','2024-01-01T00:00:00Z'])
    writer.writerow(['200','100','Selected reply within the same thread','31','2024-01-02T00:00:00Z'])
    writer.writerow(['300','300','Selected post with no replies','0','2024-01-03T00:00:00Z'])
    csv_source = selected.getvalue().encode('utf-8-sig')
    fixed = {'start_time': None, 'end_time': None}

    def row(identifier, parent='100'):
        return {'id':str(identifier),'parent_post_id':parent,'conversation_id':'100',
                'text':'Literal reply <script>','created_at':'2024-02-01T00:00:00Z',
                'username':'tester','author_id':'900','likes':1,'reposts':2,'replies':3,'quotes':4,
                'images':'["https://pbs.twimg.com/media/reply.jpg"]','language':'en'}

    def api(route):
        if route.request.method == 'GET':
            return route.fulfill(json={'ok':True,'configured':True,'google_client_id':''})
        data = route.request.post_data_json
        assert data['action']=='replies', 'Reply workflow must not repeat the initial keyword search'
        assert 'Authorization' not in route.request.headers
        calls.append({'data':data,'at':time.monotonic()})
        assert data['count']==500
        if fixed['start_time'] is None:
            fixed.update(start_time=data['start_time'],end_time=data['end_time'])
        assert data['start_time']==fixed['start_time'] and data['end_time']==fixed['end_time']
        if data['conversation_id']=='300':
            return route.fulfill(json={'rows':[],'next_token':None,'scanned_count':0})
        assert data['conversation_id']=='100', 'Shared conversations must be fetched once'
        cursor=data['next_token']
        if cursor=='invalid':
            return route.fulfill(status=400,json={'code':'cursor_invalid','error':'X rejected the saved cursor.'})
        if cursor is None:
            return route.fulfill(json={'rows':[row(i) for i in range(1000,1500)],'next_token':'A','scanned_count':500})
        if cursor=='A':
            if not flags['rate_done']:
                flags['rate_done']=True
                return route.fulfill(status=429,json={'code':'rate_limited','error':'Rate limited','retry_at':time.time()+1.2})
            return route.fulfill(json={'rows':[row(1000),row(1500),row(2000,'200'),row(9999,'888')],
                                      'next_token':'B','scanned_count':4})
        assert cursor=='B'
        if not flags['usage_done']:
            flags['usage_done']=True
            return route.fulfill(status=402,json={'code':'usage_limit','error':'More API credits required.'})
        return route.fulfill(json={'rows':[row(1501)],'next_token':None,'scanned_count':1})

    def setup(page):
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('dialog',lambda dialog:dialog.accept())
        page.route('**/api/index',api)
        page.route('https://accounts.google.com/gsi/client',lambda route:route.fulfill(content_type='application/javascript',body=''))
        import base64
        page.route('https://pbs.twimg.com/**',lambda route:route.fulfill(content_type='image/png',body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')))
        page.goto(os.environ.get('APP_BASE_URL','http://127.0.0.1:8000'))
        page.wait_for_function('() => !document.querySelector("#prepare-replies").disabled')

    def checkpoint(page):
        with page.expect_download() as result:
            page.click('#download-reply-checkpoint')
        return open(result.value.path(),encoding='utf-8').read()

    def combined(page):
        with page.expect_download() as result:
            page.click('#download-combined')
        return list(csv.DictReader(io.StringIO(open(result.value.path(),encoding='utf-8-sig').read())))

    page=browser.new_page(viewport={'width':1280,'height':1000})
    setup(page)
    # Reject scientific notation; no paid requests occur during import or validation.
    page.set_input_files('#selected-posts-file',{'name':'broken.csv','mimeType':'text/csv','buffer':b'id,conversation_id\n1.23E+18,100\n'})
    page.click('#prepare-replies')
    assert 'digit strings' in page.locator('#reply-status').inner_text()
    assert len(calls)==0
    page.set_input_files('#selected-posts-file',{'name':'selected.csv','mimeType':'text/csv','buffer':csv_source})
    page.wait_for_function('() => document.querySelector("#reply-start").value === "2024-01-01"')
    page.fill('#reply-end','2024-04-30')
    page.select_option('#reply-page-size','500')
    page.click('#prepare-replies')
    page.locator('#reply-controls').wait_for(state='visible')
    assert len(calls)==0
    assert '3 selected posts in 2 conversations' in page.locator('#reply-status').inner_text()
    page.select_option('#reply-budget','1')
    page.click('#run-replies')
    page.wait_for_function('() => document.querySelector("#reply-status").textContent.includes("Paused after 1 API calls")')
    assert len(calls)==1
    first=json.loads(checkpoint(page))
    assert first['threads'][0]['cursor']=='A'
    assert len(first['threads'][0]['replies'])==500
    assert not first['threads'][0]['complete']
    partial=combined(page)
    assert len(partial)==502
    assert partial[0]['engagement']=='42.5'
    assert partial[0]['text']=='Selected root, with comma\nand newline'
    assert all(item['reply_collection_status']!='complete' for item in partial)
    assert partial[-1]['reply_collection_status']=='not_searched'
    assert partial[-1]['reply_id']==''
    before=len(calls)
    page.reload()
    page.wait_for_function('() => !document.querySelector("#run-replies").disabled')
    assert len(calls)==before, 'Reload must never start requests automatically'
    page.select_option('#reply-budget','0')
    page.click('#run-replies')
    page.wait_for_function('() => document.querySelector("#reply-status").textContent.includes("More API credits")')
    assert len(calls)==4
    assert [call['data']['next_token'] for call in calls]==[None,'A','A','B']
    assert calls[2]['at']-calls[1]['at']>=1.0, 'Rate-limited requests must wait for reset'
    page.wait_for_timeout(1500)
    assert len(calls)==4, 'Usage caps must not loop automatically'
    saved=checkpoint(page)
    transferred=json.loads(saved)
    assert transferred['threads'][0]['cursor']=='B'
    assert len(transferred['threads'][0]['replies'])==502
    assert len({reply['id'] for reply in transferred['threads'][0]['replies']})==502

    # Import the checkpoint in a completely separate browser context/device-equivalent.
    context=browser.new_context(viewport={'width':1280,'height':1000})
    other=context.new_page();setup(other)
    other.set_input_files('#reply-checkpoint-file',{'name':'checkpoint.json','mimeType':'application/json','buffer':saved.encode()})
    other.locator('#reply-controls').wait_for(state='visible')
    assert len(calls)==4
    other.select_option('#reply-budget','0')
    other.click('#run-replies')
    other.wait_for_function('() => document.querySelector("#reply-status").textContent.includes("Reply collection complete")')
    assert len(calls)==6
    assert calls[4]['data']['next_token']=='B'
    assert calls[5]['data']['conversation_id']=='300'
    result=combined(other)
    assert len(result)==504
    root=[item for item in result if item['id']=='100']
    child=[item for item in result if item['id']=='200']
    empty=[item for item in result if item['id']=='300']
    assert len(root)==502 and len(child)==1 and len(empty)==1
    assert len({item['reply_id'] for item in root+child})==503
    assert all(item['reply_collection_status']=='complete' for item in root+child)
    assert empty[0]['reply_collection_status']=='complete_no_replies' and empty[0]['reply_id']==''
    assert {item['engagement'] for item in root}=={'42.5'}
    assert child[0]['reply_parent_post_id']=='200'
    assert all(item['reply_parent_post_id']=='100' for item in root)
    other.locator('#reply-summary button').first.click()
    assert other.locator('#reply-preview .reply-card').count()==25
    assert other.locator('#reply-preview img').first.get_attribute('src')=='https://pbs.twimg.com/media/reply.jpg'
    other.screenshot(path='/tmp/twitt-replies.png',full_page=True)
    other.set_viewport_size({'width':390,'height':844})
    assert other.evaluate('document.documentElement.scrollWidth <= innerWidth')

    # Expired cursors stop explicitly. A user-authorized rescan retains and deduplicates prior replies.
    invalid=json.loads(saved)
    invalid['threads'][0]['cursor']='invalid'
    invalid['threads'][0]['seenTokens'].append('invalid')
    other.set_input_files('#reply-checkpoint-file',{'name':'expired.json','mimeType':'application/json','buffer':json.dumps(invalid).encode()})
    other.wait_for_function('() => document.querySelector("#reply-status").textContent.includes("Checkpoint restored")')
    other.click('#run-replies')
    other.wait_for_function('() => !document.querySelector("#restart-reply-cursor").hidden')
    before=len(calls)
    other.wait_for_timeout(1200)
    assert len(calls)==before
    assert calls[-1]['data']['next_token']=='invalid'
    other.click('#restart-reply-cursor')
    assert len(calls)==before, 'Restart confirmation prepares state but must not spend calls'
    other.click('#run-replies')
    other.wait_for_function('() => document.querySelector("#reply-status").textContent.includes("Reply collection complete")')
    final=combined(other)
    assert len(final)==504
    assert len({item['reply_id'] for item in final if item['reply_id']})==503
    # Manual pause stops after saving the in-flight page; its next cursor survives.
    other.set_input_files('#reply-checkpoint-file',{'name':'earlier.json','mimeType':'application/json','buffer':json.dumps(first).encode()})
    other.wait_for_function('() => document.querySelector("#reply-status").textContent.includes("Checkpoint restored")')
    other.click('#run-replies')
    other.wait_for_function('async () => (await CollectionStore.loadReplies()).threads[0].pages === 2')
    other.click('#pause-replies')
    other.wait_for_function('() => document.querySelector("#reply-status").textContent.includes("Paused by you")')
    paused=json.loads(checkpoint(other))
    assert paused['threads'][0]['cursor']=='B'
    assert len(paused['threads'][0]['replies'])==502
    assert not paused['threads'][0]['complete']
    assert not errors,errors
    context.close();browser.close()
    print('Replies browser checks passed: CSV validation, original engagement preserved, >500 replies, direct-parent matching, shared-thread reuse, request budget, reset waiting, usage-cap pause, checkpoint transfer, deduplication, expired-cursor recovery, preview/images, mobile, combined CSV including zero replies.')
