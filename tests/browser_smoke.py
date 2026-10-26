import json,csv,io,os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1280,'height':1000})
 errors=[];calls=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 def route(r):
  if r.request.method=='GET':return r.fulfill(json={'ok':True,'configured':True})
  data=r.request.post_data_json;calls.append(data)
  assert 'x-app-password' not in r.request.headers
  # 25 posts in first month exercise Show more; one in second month.
  count=10 if data['candidates'] in (5,10) else (25 if data['start']=='2024-01' else 1)
  rows=[]
  for i in range(count):
   rows.append({'id':data['start']+str(i),'url':'https://x.com/i/web/status/1','username':'tester','created_at':'2024-01-02T00:00:00Z','month':data['start'],'engagement_score':i,'text':'=formula, café\n<script>','media':json.dumps([{'type':'photo','url':'https://pbs.twimg.com/media/test.jpg','alt_text':'Associated image'}])})
  r.fulfill(json={'rows':rows,'next_token':'more-available' if data['candidates'] in (5,10) else None})
 page.route('**/api/index',route)
 import base64
 page.route('https://pbs.twimg.com/**',lambda r:r.fulfill(content_type='image/png',body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')))
 page.goto(os.environ.get('APP_BASE_URL', 'http://127.0.0.1:8000'))
 assert page.locator('input[type=password]').count()==0
 assert page.locator('#post-limit').input_value()=='5'
 page.select_option('#post-limit','500')
 page.fill('#query','#climate');page.fill('#start','2024-01');page.fill('#end','2024-02')
 page.click('#submit');page.locator('#download').wait_for(state='visible')
 assert len(calls)==2
 assert page.locator('#gallery .post').count()==24
 page.click('#more');assert page.locator('#gallery .post').count()==26
 assert page.locator('#gallery img').first.get_attribute('alt')=='Associated image'
 assert page.locator('#gallery .post-text').first.inner_text()=='=formula, café\n<script>'
 with page.expect_download() as d:page.click('#download')
 rows=list(csv.DictReader(io.StringIO(open(d.value.path(),encoding='utf-8-sig').read())))
 assert len(rows)==26
 assert rows[0]['text']=="'=formula, café\n<script>"
 assert rows[0]['engagement_score']=='0'
 assert len({row['month'] for row in rows})==2
 page.select_option('#post-limit','10')
 page.fill('#end','2024-01')
 assert 'up to 10 exported posts' in page.locator('#estimate').inner_text()
 before=len(calls)
 page.click('#submit');page.locator('#download').wait_for(state='visible')
 assert len(calls)==before+1, 'Test collection must not fetch another page after reaching ten'
 assert calls[-1]['count']==10
 assert calls[-1]['candidates']==10
 assert page.locator('#gallery .post').count()==10
 with page.expect_download() as d:page.click('#download')
 small=list(csv.DictReader(io.StringIO(open(d.value.path(),encoding='utf-8-sig').read())))
 assert len(small)==10
 assert [row['engagement_score'] for row in small]==[str(i) for i in range(10)]
 page.select_option('#post-limit','5')
 assert 'up to 5 exported posts' in page.locator('#estimate').inner_text()
 before=len(calls)
 page.click('#submit');page.locator('#download').wait_for(state='visible')
 assert len(calls)==before+1
 assert calls[-1]['count']==10 and calls[-1]['candidates']==5
 assert page.locator('#gallery .post').count()==5
 with page.expect_download() as d:page.click('#download')
 five=list(csv.DictReader(io.StringIO(open(d.value.path(),encoding='utf-8-sig').read())))
 assert len(five)==5
 assert [row['engagement_score'] for row in five]==[str(i) for i in range(5)]
 page.screenshot(path='/tmp/twitt-vercel-desktop.png',full_page=True)
 page.set_viewport_size({'width':390,'height':844})
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
 assert not errors,errors
 browser.close()
 print('Browser checks passed: multi-month search without password, web preview, images, show-more, actual CSV download/content, 5-post default, 5/10-post limits without extra pagination, mobile layout. Simulated X responses.')
