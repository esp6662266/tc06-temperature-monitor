import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
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
  const response=await api(req('ingest',{method:'POST',upload:true,body:{record:record(),audio_base64:'not-a-wave'}}));
  assert.equal(response.status,400);
});
test('store errors are not acknowledged; public reads ignore stale cookies',async()=>{
  const {api,cookie}=await fixture();
  assert.equal((await api(req('latest',{cookie:'old_session=irrelevant'}))).status,200);
  const bad=createAPI(()=>{throw Error('offline');});
  assert.equal((await bad(req('ingest',{method:'POST',upload:true,body:{record:record()}}))).status,503);
});
test('KST day history and WAV access are public with validated identifiers',async()=>{
  const {api,cookie}=await fixture();
  assert.equal((await api(req('audio?id=notice-stale'))).status,404);
  assert.equal((await api(req('audio?id=../../secret',{cookie}))).status,400);
  const row=record(0,{captured_at:'2026-01-01T16:00:00.000Z',recorded_at:'2026-01-01T16:00:00.000Z'});
  await api(req('ingest',{method:'POST',upload:true,body:{record:row}}));
  const response=await api(req('history?day=2026-01-02',{cookie}));
  assert.ok((await response.text()).includes(row.id));
});
test('WAV content is reused and audio hashes must match uploaded bytes',async()=>{
  const {store,api,cookie}=await fixture();
  const wav=Buffer.alloc(100);wav.write('RIFF');wav.writeUInt32LE(92,4);wav.write('WAVE',8);
  const digest=createHash('sha256').update(wav).digest('hex');
  for(let i=0;i<2;i++) {
    const body={record:record(),audio_hash:digest,...(i===0?{audio_base64:wav.toString('base64')}:{})};
    assert.equal((await api(req('ingest',{method:'POST',upload:true,body}))).status,200);
  }
  assert.equal([...store.data.keys()].filter(k=>k.startsWith('audio/')).length,1);
  assert.equal((await api(req('audio?id='+digest,{cookie}))).headers.get('Content-Type'),'audio/wav');
  const wrong={record:record(),audio_hash:'a'.repeat(64),audio_base64:wav.toString('base64')};
  assert.equal((await api(req('ingest',{method:'POST',upload:true,body:wrong}))).status,400);
});
