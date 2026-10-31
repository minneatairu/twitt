const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
(async () => {
  let written;
  const context = {window:{}, URLSearchParams, AbortSignal, fetch:async(url,options) => {
    const path = decodeURIComponent(new URL(url).pathname);
    let data = {};
    if (options.method === 'GET') {
      data = path.includes('/values/') ? {values:[]} : {sheets:[{properties:{sheetId:0,title:'Logs'}}]};
    } else {
      const body = JSON.parse(options.body);
      if (path.includes(':append')) written = body.values[0];
      else assert.ok(path.endsWith("'Logs'!A1"), 'Only the Logs header and row should be written');
    }
    return {ok:true,json:async()=>data};
  }};
  vm.runInNewContext(readFileSync(join(__dirname,'../static/sheets.js'),'utf8'),context);
  const cases = [
    ['#dalle2','2022-04','DALL·E 2'], ['#DALLE2','2022-07','DALL·E 2'],
    ['#dalle2','2022-08','Unclassified'], ['#dalle3','2023-10','DALL·E 3'],
    ['"DALL-E 3"','2024-01','DALL·E 3'], ['#dalle3','2024-02','Unclassified'],
    ['4o image generation','2025-03','GPT-4o Image Generation'],
    ['#gptimages','2025-06','GPT-4o Image Generation'],
    ['#gptimages','2025-07','GPT Image 1.5'], ['ChatGPT images','2025-10','GPT Image 1.5'],
    ['#chatgptimages','2026-04','ChatGPT Images 2.0'], ['#gptimages','2026-07','ChatGPT Images 2.0'],
    ['#gptimages','2026-08','Unclassified'], ['#gptimages','2026-09','ChatGPT Images 2.5'],
    ['#gptimages','2026-10','Unclassified'], ['#solar','2025-07','Unclassified'],
    ['#gptimagesextra','2025-07','Unclassified'], ['#notgptimages','2025-07','Unclassified'],
    ['#dalle2','2025-07','Unclassified'], ['(#gptimages OR #chatgptimages) lang:en','2025-07','GPT Image 1.5'],
    ['#solar -#gptimages','2025-07','Unclassified'], ['#solar -"ChatGPT images"','2025-07','Unclassified']
  ];
  for (const [term,month,expected] of cases) {
    const job = {reporting:{key:'job-key',workbookId:'book',term,month,retrievedAt:'2026-10-31T00:00:00Z'},headers:['replies'],posts:[{values:['0']}],threads:[],status:'complete'};
    await context.window.TwittSheets.writeReport(job,'test-token',async()=>{});
    assert.equal(written[9],expected,`${term}, ${month}`);
    assert.equal(written[2],term,'Original search term is preserved');
    assert.equal(job.reporting.term,term);
    assert.equal(written[8],1,'Zero-reply count remains in its existing column');
  }
  console.log(`PASS: ${cases.length} model-label cases, including shared hashtags, window boundaries, negatives and unmatched queries.`);
})().catch(error=>{console.error(error);process.exit(1)});
