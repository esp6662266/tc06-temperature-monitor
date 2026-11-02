import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAPI} from '../server/api.mjs';
import {MemoryStore} from '../server/memory-store.mjs';
const req=(data,origin)=>new Request('https://test.invalid/api/settings',data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(data)});

test('public collection setting persists with revision checks and cached GET only',async()=>{
  const store=new MemoryStore(),api=createAPI(()=>store);
  const first=await api(req());assert.equal(first.status,200);
  assert.match(first.headers.get('Netlify-CDN-Cache-Control'),/durable/);
  assert.deepEqual(await first.json(),{interval_seconds:60,revision:0,updated_at:null});
  const saved=await api(req({interval_seconds:300,revision:0}));assert.equal(saved.status,200);
  assert.equal(saved.headers.get('Netlify-CDN-Cache-Control'),'no-store');
  assert.equal((await saved.json()).revision,1);
  const fresh=createAPI(()=>store);
  assert.equal((await(await fresh(req())).json()).interval_seconds,300);
  assert.equal((await api(req({interval_seconds:600,revision:0}))).status,409);
  assert.equal((await(await fresh(req())).json()).interval_seconds,300);
});
test('invalid settings, cross-origin writes and concurrent editors cannot replace a valid interval',async()=>{
  const store=new MemoryStore(),api=createAPI(()=>store);
  for(const value of [null,true,'300',29,3601,300.5])assert.equal((await api(req({interval_seconds:value,revision:0}))).status,400);
  assert.equal((await api(req({interval_seconds:300,revision:0},'https://other.invalid'))).status,403);
  const results=await Promise.all([api(req({interval_seconds:300,revision:0})),api(req({interval_seconds:600,revision:0}))]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(store.data.size,1);
});
test('actual collector interval survives history without extending freshness or creating records',async()=>{
  const store=new MemoryStore(),api=createAPI(()=>store);
  await api(req({interval_seconds:300,revision:0}));
  const time=new Date(Date.now()-160000).toISOString();
  const row={id:randomUUID(),asset:'TC-06',device_id:'synthetic',status:'ok',value_c:123.4,confidence:95,source_clock:'12:34:56',captured_at:time,recorded_at:time,record_interval_seconds:300,collector_version:'0.7.0'};
  assert.equal((await api(new Request('https://test.invalid/api/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({record:row})}))).status,200);
  const latest=await(await api(new Request('https://test.invalid/api/latest'))).json();
  assert.equal(latest.collection_settings.interval_seconds,300);
  assert.equal(latest.record.record_interval_seconds,300);assert.equal(latest.record.collector_version,'0.7.0');
  assert.equal(latest.record.captured_at,time);assert.equal(latest.fresh,false);assert.equal(latest.max_age_ms,150000);
  assert.equal([...store.data.keys()].filter(k=>k.startsWith('records/')).length,1);
});
