"""Single-month collection, resumable Sheets export, and safe multi-month migration."""
import csv
import io
import json
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    calls,creates,writes,errors=[],[],[],[]
    settings={'fail_write':False,'fail_at':None}
    def api(route):
        if route.request.method=='GET':
            return route.fulfill(json={'ok':True,'configured':True,'google_client_id':'public-test.apps.googleusercontent.com'})
        data=route.request.post_data_json;calls.append(data)
        assert data['query']=='#climate' and data['start']==data['end']
        first=int(data.get('next_token') or 0)
        rows=[{'id':str(1000+i),'month':data['start'],'text':'=SUM(1,2)\nLiteral text','username':'tester',
               'created_at':'2024-01-01T00:00:00Z','likes':i,'reposts':2,'replies':3,'quotes':4,
               'author_name':'Test','author_followers':123,'author_verified':True,'impressions':30,'bookmarks':10,
               'media':'[{"type":"photo","url":"https://pbs.twimg.com/media/test.jpg","alt_text":"Post image"}]',
               'images':'["https://pbs.twimg.com/media/test.jpg"]'} for i in range(first,first+data['count'])]
        route.fulfill(json={'rows':rows,'next_token':str(first+data['count']) if first+data['count']<500 else None})
    def google(route):
        body=route.request.post_data_json
        assert route.request.headers['authorization']=='Bearer test-only-token'
        if route.request.method=='POST':
            creates.append(body);return route.fulfill(json={'spreadsheetId':'single-sheet-'+str(len(creates))})
        writes.append({'url':route.request.url,'body':body})
        if settings['fail_write'] or (settings['fail_at'] and settings['fail_at'] in route.request.url):
            settings['fail_write']=False;settings['fail_at']=None
            return route.fulfill(status=429,json={'error':{'message':'rate limited'}})
        return route.fulfill(json={'updatedRows':len(body['values'])})
    def setup(page):
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('dialog',lambda dialog:dialog.accept())
        page.route('**/api/index',api)
        page.route('https://sheets.googleapis.com/**',google)
        page.route('https://accounts.google.com/gsi/client',lambda route:route.fulfill(content_type='application/javascript',body='''
        window.google={accounts:{oauth2:{initTokenClient(c){return {requestAccessToken(){c.callback(window.denyGoogle?{error:'denied'}:{access_token:'test-only-token'});}};}}}};
        '''))
        import base64
        page.route('https://pbs.twimg.com/**',lambda route:route.fulfill(content_type='image/png',body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')))
        page.goto(os.environ.get('APP_BASE_URL','http://127.0.0.1:8000'))
        page.wait_for_function('() => !document.querySelector("#submit").disabled')
    def downloaded(page,selector):
        if 'previous' in selector and not page.locator('#previous-collection').evaluate('(element) => element.open'):
            page.locator('#previous-collection summary').click()
        with page.expect_download() as result:page.click(selector)
        return open(result.value.path(),encoding='utf-8-sig').read()
    page=browser.new_page(viewport={'width':1280,'height':1000});setup(page)
    assert page.locator('.month-slot').count()==1
    assert page.locator('input[type=month]').count()==1
    assert page.locator('#post-limit').input_value()=='5'
    page.fill('#collection-title','Single month research');page.fill('#query','#climate');page.fill('#month-0','2024-01')
    page.click('#submit')
    page.wait_for_function('async () => (await CollectionStore.load())?.version === 2')
    assert page.locator('#collection-title').is_enabled() and page.locator('#query').is_enabled() and page.locator('#month-0').is_enabled()
    page.fill('#month-0','2024-02');page.click('#submit')
    page.wait_for_function('async () => (await CollectionStore.load()).month === "2024-02"')
    page.fill('#month-0','2024-01');page.click('#submit')
    page.wait_for_function('async () => (await CollectionStore.load()).month === "2024-01"')
    assert len(calls)==0
    page.evaluate('window.denyGoogle=true');page.click('#search-month')
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("failed")')
    assert len(calls)==0 and len(creates)==0
    page.evaluate('window.denyGoogle=false');settings['fail_write']=True;page.click('#search-month')
    page.wait_for_function('() => document.querySelector("#slot-status-0").textContent.includes("Google’s write limit")')
    assert len(calls)==1 and len(creates)==1
    before=len(calls);page.click('#search-month')
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("saved")')
    assert len(calls)==before and len(creates)==1
    header=next(write['body']['values'][0] for write in writes if 'A1?' in write['url'])
    assert {'engagement','engagement_score','attachments','media','bookmarks','raw_json','geo','impressions','author_followers','author_name','author_verified','language'}.isdisjoint(header)
    assert {'likes','reposts','replies','quotes','images'}.issubset(header)
    assert creates[0]['sheets'][0]['properties']['gridProperties']['rowCount']==501
    result=list(csv.DictReader(io.StringIO(downloaded(page,'#download'))))
    assert len(result)==5 and [row['id'] for row in result]==[str(1000+i) for i in range(5)]
    assert {'engagement','engagement_score','attachments','media'}.isdisjoint(result[0])
    assert result[0]['images']=='["https://pbs.twimg.com/media/test.jpg"]'
    assert page.locator('#gallery img').first.get_attribute('alt')=='Post image'
    page.reload();page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("saved")')
    assert len(calls)==before
    page.fill('#month-0','2024-02');assert page.locator('#search-month').is_enabled()
    page.fill('#month-0','2024-01')
    page.click('#new-collection');page.fill('#collection-title','Larger search');page.select_option('#post-limit','500')
    settings['fail_at']='A102?';page.click('#search-month')
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("failed")')
    before=len(calls);assert before==6
    failed=writes[-1];page.reload()
    page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("failed")')
    page.click('#search-month');page.wait_for_function('() => document.querySelector("#slot-0").classList.contains("saved")')
    assert len(calls)==before and len(creates)==2
    assert len([write for write in writes if write==failed])==2
    assert page.locator('#gallery .post').count()==24
    page.click('#more');assert page.locator('#gallery .post').count()==48
    page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

    # Old four-month data is archived intact, never silently truncated to one month.
    context=browser.new_context();legacy=context.new_page();setup(legacy)
    slots=[{'month':'2024-0'+str(i+1),'rows':[{'id':str(10+i),'text':'Previous data','media':'[]'}],
            'status':'saved','searchComplete':True,'cursor':None,'endTime':None,'seenTokens':[],
            'uploaded':1,'sheetStart':2+i,'error':''} for i in range(4)]
    previous={'version':1,'title':'Previous four months','query':'#climate','limit':5,'createdAt':'2024-01-01',
              'sheet':{'id':'old-shared-sheet','nextRow':6,'headerWritten':True},'slots':slots}
    legacy.evaluate('async data => CollectionStore.save(data)',previous)
    before=len(calls);legacy.reload();legacy.locator('#previous-collection').wait_for(state='visible')
    assert len(calls)==before
    assert legacy.locator('input[type=month]').count()==1
    prior=list(csv.DictReader(io.StringIO(downloaded(legacy,'#download-previous'))))
    assert [row['id'] for row in prior]==['10','11','12','13']
    assert json.loads(downloaded(legacy,'#download-previous-progress'))['slots']==slots
    assert legacy.locator('#open-previous').get_attribute('href').endswith('/old-shared-sheet/edit')
    legacy.fill('#collection-title','New one-month search');legacy.fill('#month-0','2024-05');legacy.click('#submit')
    legacy.wait_for_function('async () => (await CollectionStore.load()).version === 2')
    legacy.reload();legacy.locator('#previous-collection').wait_for(state='visible')
    assert len(list(csv.DictReader(io.StringIO(downloaded(legacy,'#download-previous')))))==4
    assert len(calls)==before
    # An old collection containing only one month migrates in place with its file ID/rows.
    previous['slots']=slots[:1]
    legacy.evaluate('async data => CollectionStore.save(data)',previous);legacy.reload()
    legacy.wait_for_function('async () => (await CollectionStore.load()).version === 2')
    assert legacy.evaluate('async () => (await CollectionStore.load()).sheet.id')=='old-shared-sheet'
    assert legacy.evaluate('async () => (await CollectionStore.load()).rows[0].id')=='10'
    assert len(calls)==before
    assert not errors,errors
    context.close();browser.close()
    print('Single-month browser checks passed: one month, editable settings, no engagement fields, X order, images, upload retry/reload without X refetch, 500-post batches, mobile, preservation of old four-month and one-month collections.')
