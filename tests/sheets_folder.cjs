const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
(async()=>{
for (const kind of ['month','replies']) {
 let folders=[],parents=['root'],creates=0,moves=0,fail=true,checkpoints=0;
 const context={window:{},URLSearchParams,AbortSignal,TextEncoder,setTimeout,fetch:async(url,options)=>{
  let result={};
  if(url.startsWith('https://www.googleapis.com/drive/')) {
   const u=new URL(url);
   if(options.method==='GET' && u.pathname.endsWith('/files')) result={files:folders};
   else if(options.method==='POST') {assert.equal(JSON.parse(options.body).name,'Twitter Research');folders=[{id:'folder1'}];result=folders[0];}
   else if(options.method==='GET') result={parents};
   else if(options.method==='PATCH') {if(fail){fail=false;return {ok:false,status:403};}assert.equal(u.searchParams.get('addParents'),'folder1');assert.equal(u.searchParams.get('removeParents'),'root');parents=['folder1'];moves++;result={id:'sheet1'};}
   else throw Error(url);
  } else if(url==='https://sheets.googleapis.com/v4/spreadsheets') {creates++;result={spreadsheetId:'sheet1'};}
  return {ok:true,json:async()=>result};
 }};
 vm.runInNewContext(readFileSync(require('node:path').join(__dirname,'../static/sheets.js'),'utf8'),context);
 const sheet={nextRow:2},slot={rows:[{text:'test'}],month:'2024-01',uploaded:0};
 const save=()=>kind==='month'?context.window.TwittSheets.writeMonth({title:'Test',sheet},slot,['text'],'token',async()=>checkpoints++,()=>{}):context.window.TwittSheets.writeTable('Replies_Test',[['text'],['test']],sheet,'token',async()=>checkpoints++,()=>{});
 await assert.rejects(save(),/Google Drive returned HTTP 403/);
 assert.equal(sheet.id,'sheet1');assert.ok(checkpoints);
 await save(); await save();
 assert.equal(creates,1);assert.equal(moves,1);assert.equal(folders.length,1);
 console.log('PASS',kind,'folder creation, retry without duplicate spreadsheet, folder reuse and idempotent move');
}
})().catch(e=>{console.error(e);process.exit(1)});
