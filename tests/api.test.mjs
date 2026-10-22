import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAPI, updateLatest, validateRecord } from '../server/api.mjs';
import { MemoryStore } from '../server/memory-store.mjs';

function record(ago=0, extra={}) {
  const timestamp = new Date(Date.now()-ago).toISOString();
  return {id:randomUUID(),asset:'TC-06',device_id:'test-fixture',captured_at:timestamp,recorded_at:timestamp,
    status:'ok',value_c:123.4,source_clock:'12:34:56',confidence:95,...extra};
}
const req = (route,{method='GET',body,cookie,upload=false}={}) => new Request('https://test.invalid/api/'+route,{
  method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
  ...(body?{body:JSON.stringify(body)}:{})});
async function fixture() {
  const store=new MemoryStore(), api=createAPI(()=>store);
  return {store,api,cookie:''};
}

// Read CSV cells independently of JSON escaping, including quoted line breaks.
function csvRows(csv) {
  const rows=[],row=[];let field='',quoted=false;
  const text=csv.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(quoted) {
      if(char==='"'&&text[i+1]==='"'){field+='"';i++;}
      else if(char==='"')quoted=false;
      else field+=char;
    } else if(char==='"')quoted=true;
    else if(char===','){row.push(field);field='';}
    else if(char==='\r'||char==='\n') {
      if(char==='\r'&&text[i+1]==='\n')i++;
      row.push(field);rows.push([...row]);row.length=0;field='';
    } else field+=char;
  }
  assert.equal(quoted,false,'CSV must close every quoted cell');
  row.push(field);rows.push(row);
  return rows;
}

test('viewing and uploading work without keys, login or cookies',async()=>{
  const {api}=await fixture();
  assert.equal((await api(req('latest'))).status,200);
  assert.equal((await api(req('ingest',{method:'POST',body:{record:record()}}))).status,200);
  assert.equal((await api(req('login',{method:'POST',body:{}}))).status,405);
  assert.equal((await createAPI(()=>new MemoryStore())(req('latest'))).status,200);
});
test('new record is readable and duplicate retry is idempotent',async()=>{
  const {api,cookie}=await fixture(), row=record();
  for(let i=0;i<2;i++) assert.equal((await api(req('ingest',{method:'POST',upload:true,body:{record:row}}))).status,200);
  const result=await (await api(req('latest',{cookie}))).json();
  assert.equal(result.record.id,row.id);assert.equal(result.fresh,true);
  const csv=await (await api(req('history?day='+new Date(Date.parse(row.captured_at)+9*3600000).toISOString().slice(0,10),{cookie}))).text();
  assert.equal(csv.split('\r\n').length,2);
});
test('old offline retries cannot replace current reading',async()=>{
  const {api,cookie}=await fixture(), old=record(360000), current=record();
  for(const row of [current,old]) await api(req('ingest',{method:'POST',upload:true,body:{record:row}}));
  const data=await (await api(req('latest',{cookie}))).json();
  assert.equal(data.record.id,current.id);
});
test('concurrent latest writes use compare-and-swap and preserve newest',async()=>{
  const store=new MemoryStore(), rows=Array.from({length:6},(_,i)=>record((6-i)*1000));
  await Promise.all(rows.map(row=>updateLatest(store,row)));
  assert.equal((await store.get('latest',{type:'json'})).id,rows.at(-1).id);
});
test('stale values and failed OCR are explicit; bad submissions are rejected',async()=>{
  const {api,cookie}=await fixture();
  await api(req('ingest',{method:'POST',upload:true,body:{record:record(160000)}}));
  assert.equal((await (await api(req('latest',{cookie}))).json()).fresh,false);
  assert.throws(()=>validateRecord(record(0,{status:'ocr_failed',value_c:123.4})));
  assert.throws(()=>validateRecord(record(0,{value_c:1234.56})));
  assert.throws(()=>validateRecord(record(0,{source_clock:null})));
  assert.throws(()=>validateRecord(record(-60000)));
  const response=await api(req('ingest',{method:'POST',upload:true,body:{record:record(),audio_base64:'legacy-ignored'}}));
  assert.equal(response.status,200);
});
test('store errors are not acknowledged; public reads ignore stale cookies',async()=>{
  const {api,cookie}=await fixture();
  assert.equal((await api(req('latest',{cookie:'old_session=irrelevant'}))).status,200);
  const bad=createAPI(()=>{throw Error('offline');});
  assert.equal((await bad(req('ingest',{method:'POST',upload:true,body:{record:record()}}))).status,503);
});
test('KST history is public and dates outside 30-day retention are rejected',async()=>{
  const {api}=await fixture();assert.equal((await api(req('audio?id=notice-stale'))).status,410);
  const at=new Date();at.setUTCHours(16,0,0,0);at.setUTCDate(at.getUTCDate()-1);
  const row=record(0,{captured_at:at.toISOString(),recorded_at:at.toISOString()});
  await api(req('ingest',{method:'POST',body:{record:row}}));
  const day=new Date(at.getTime()+9*3600000).toISOString().slice(0,10);
  assert.ok((await(await api(req('history?day='+day))).text()).includes(row.id));
  assert.equal((await api(req('history?day=2020-01-01'))).status,410);
  assert.equal((await api(req('history?day=2026-02-31'))).status,400);
});
test('history CSV round-trips normal and failed records with quotes and line breaks',async()=>{
  const {store,api}=await fixture(),at=new Date().toISOString();
  const sameDay=extra=>record(0,{captured_at:at,recorded_at:at,...extra});
  const rows=[sameDay({value_c:-12.3}),sameDay({status:'ocr_failed',value_c:null,confidence:0,source_clock:'12:"34'}),
    sameDay({status:'ocr_failed',value_c:null,confidence:0,source_clock:'a,b\r\nc\nd'})];
  for(const row of rows)assert.equal((await api(req('ingest',{method:'POST',body:{record:row}}))).status,200);
  const day=new Date(Date.parse(rows[0].captured_at)+9*3600000).toISOString().slice(0,10);
  const response=await api(req('history?day='+day));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Content-Type'),'text/csv; charset=utf-8');
  assert.equal(response.headers.get('Content-Disposition'),`attachment; filename="TC06-${day}-KST.csv"`);
  const bytes=new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);
  const csv=new TextDecoder().decode(bytes),[columns,...exported]=csvRows(csv);
  assert.deepEqual(columns,['id','asset','device_id','captured_at','recorded_at','received_at','value_c','status','source_clock','confidence']);
  assert.equal(exported.length,rows.length);
  for(const cells of exported) {
    assert.equal(cells.length,columns.length);
    const output=Object.fromEntries(columns.map((key,i)=>[key,cells[i]]));
    const input=rows.find(row=>row.id===output.id);
    assert.ok(input);
    const stored=await store.get(`records/${day}/${input.id}`,{type:'json'});
    for(const key of columns)assert.equal(output[key],String(stored[key]??''));
    assert.equal(stored.source_clock,input.source_clock);
  }
  assert.ok(csv.includes('"12:""34"'));
  assert.ok(csv.includes('"a,b\r\nc\nd"'));
  assert.ok(csv.includes(',-12.3,'),'negative temperatures remain numeric');
});
test('history CSV neutralizes formula-like text without altering stored or numeric values',async()=>{
  const {store,api}=await fixture(),at=new Date().toISOString();
  const cases=[['=1+1',"'=1+1"],['+1+1',"'+1+1"],['-1+1',"'-1+1"],['@SUM(1,2)',"'@SUM(1,2)"],
    ['\t=1+1',"'\t=1+1"],['\r=1+1',"'\r=1+1"],['\n=1+1',"'\n=1+1"],['  =1+1',"'  =1+1"],
    ['\tplain',"'\tplain"],['plain\ttext','plain\ttext'],["'=1+1","'=1+1"]];
  const rows=cases.map(([source_clock])=>record(0,{captured_at:at,recorded_at:at,device_id:'-fixture',status:'ocr_failed',value_c:null,confidence:0,source_clock}));
  const normal=record(0,{captured_at:at,recorded_at:at,device_id:'-numeric-fixture',value_c:-123.4,confidence:60});rows.push(normal);
  for(const row of rows)assert.equal((await api(req('ingest',{method:'POST',body:{record:row}}))).status,200);
  const day=new Date(Date.parse(normal.captured_at)+9*3600000).toISOString().slice(0,10);
  const response=await api(req('history?day='+day));assert.equal(response.status,200);
  const [columns,...exported]=csvRows(await response.text());
  const byId=new Map(exported.map(cells=>[cells[0],Object.fromEntries(columns.map((key,i)=>[key,cells[i]]))]));
  for(const [index,[source_clock,expected]]of cases.entries()) {
    const input=rows[index],output=byId.get(input.id);
    assert.equal(output.source_clock,expected);
    assert.equal(output.device_id,"'-fixture");
    assert.equal(output.value_c,'');assert.equal(output.confidence,'0');
    assert.equal((await store.get(`records/${day}/${input.id}`,{type:'json'})).source_clock,source_clock);
  }
  assert.equal(byId.get(normal.id).value_c,'-123.4');
  assert.equal(byId.get(normal.id).confidence,'60');
  assert.equal(byId.get(normal.id).device_id,"'-numeric-fixture");
});
test('legacy audio submissions are ignored and only record text is stored',async()=>{
  const {store,api}=await fixture();
  assert.equal((await api(req('ingest',{method:'POST',body:{record:record(),audio_base64:'legacy-wave',audio_hash:'a'.repeat(64),notice_audio_base64:'legacy'}}))).status,200);
  assert.equal([...store.data.keys()].filter(k=>k.startsWith('audio/')).length,0);
  const latest=(await(await api(req('latest'))).json()).record;assert.equal('audio_id' in latest,false);assert.equal('has_audio' in latest,false);
});
test('expired offline retries are explicitly discarded without recreating deleted records',async()=>{
  const {store,api}=await fixture();const row=record(40*86400000);
  const response=await api(req('ingest',{method:'POST',body:{record:row}}));assert.equal(response.status,410);
  const data=await response.json();assert.equal(data.discarded,'retention_expired');assert.equal(data.id,row.id);assert.equal(store.data.size,0);
});
test('retention policy is public and expired latest is hidden before physical cleanup',async()=>{
  const {store,api}=await fixture();await store.setJSON('latest',record(40*86400000));
  assert.equal((await(await api(req('latest'))).json()).record,null);
  assert.equal((await(await api(req('retention'))).json()).retention_days,30);
});

test('failed OCR keeps the real last normal record with its original timestamps',async()=>{
 const {store,api}=await fixture(),good=record(600000);
 await api(req('ingest',{method:'POST',body:{record:good}}));
 for(const [index,status] of ['value_suspect','low_confidence','stale_source','source_error'].entries()){
  const bad=record((4-index)*1000,{status,value_c:null});await api(req('ingest',{method:'POST',body:{record:bad}}));
  const data=await(await api(req('latest'))).json();assert.equal(data.record.status,status);assert.equal(data.last_good.id,good.id);assert.equal(data.last_good.captured_at,good.captured_at);assert.equal(data.last_good.value_c,good.value_c);
 }
 assert.equal([...store.data.keys()].filter(k=>k.startsWith('records/')).length,5);
});
test('offline and concurrent normal retries cannot move last normal state backwards',async()=>{
 const {store,api}=await fixture(),rows=Array.from({length:6},(_,i)=>record((6-i)*1000));
 await Promise.all(rows.map(row=>updateLatest(store,row,'last-good')));
 await api(req('ingest',{method:'POST',body:{record:rows[0]}}));
 assert.equal((await(await api(req('latest'))).json()).last_good.id,rows.at(-1).id);
});
test('a new browser can recover last normal from existing pre-upgrade history once',async()=>{
 const {store,api}=await fixture(),good=record(600000),older=record(86400000),bad=record(0,{status:'value_suspect',value_c:null});
 for(const row of [good,older,bad])await store.setJSON(`records/${new Date(Date.parse(row.captured_at)+9*3600000).toISOString().slice(0,10)}/${row.id}`,row);
 await store.setJSON('latest',bad);let lists=0;const list=store.list.bind(store);store.list=(...args)=>{lists++;return list(...args);};
 const data=await(await api(req('latest'))).json();assert.equal(data.last_good.id,good.id);assert.equal(data.last_good.captured_at,good.captured_at);const after=lists;
 await api(req('latest'));assert.equal(lists,after);assert.equal([...store.data.keys()].filter(k=>k.startsWith('records/')).length,3);
});
test('empty last normal bootstrap is memoized and normal collection resumes it',async()=>{
 const {store,api}=await fixture();let lists=0;const list=store.list.bind(store);store.list=(...args)=>{lists++;return list(...args);};
 assert.equal((await(await api(req('latest'))).json()).last_good,null);await api(req('latest'));assert.equal(lists,1);
 const row=record();await api(req('ingest',{method:'POST',body:{record:row}}));assert.equal((await(await api(req('latest'))).json()).last_good.id,row.id);
});
test('expired last normal values are never exposed to a new browser',async()=>{
 const {store,api}=await fixture();await store.setJSON('last-good',record(40*86400000));assert.equal((await(await api(req('latest'))).json()).last_good,null);
});
test('historical bootstrap cannot overwrite a newer normal upload arriving during recovery',async()=>{
 const {store,api}=await fixture(),old=record(600000),newer=record();const key=`records/${new Date(Date.parse(old.captured_at)+9*3600000).toISOString().slice(0,10)}/${old.id}`;
 await store.setJSON(key,old);const get=store.get.bind(store);let injected=false;store.get=async(k,options)=>{const data=await get(k,options);if(k===key&&!injected){injected=true;await updateLatest(store,newer,'last-good');}return data;};
 assert.equal((await(await api(req('latest'))).json()).last_good.id,newer.id);
});
