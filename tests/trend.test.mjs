import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {aggregateTrend,trendWindow,updateTrend,getTrend} from '../server/trend.mjs';import {createAPI} from '../server/api.mjs';import {MemoryStore} from '../server/memory-store.mjs';
const now=Date.parse('2026-10-15T15:10:30.000Z');
function record(time,value=123.4,status='ok'){return{id:randomUUID(),asset:'TC-06',device_id:'synthetic-trend-test',captured_at:time,recorded_at:time,status,value_c:status==='ok'?value:null,confidence:95,source_clock:'00:00:00'};}
const entry=row=>[row.id,[Date.parse(row.captured_at),row.value_c,row.status,Date.parse(row.recorded_at)]];
test('five-minute candles preserve first, high, low, last and failed readings',()=>{
 const rows=[record('2026-10-15T15:04:00Z',110),record('2026-10-15T15:00:00Z',100),record('2026-10-15T15:01:00Z',130),record('2026-10-15T15:02:00Z',0,'ocr_failed'),record('2026-10-15T15:03:00Z',90)];
 const bars=aggregateTrend(rows.map(entry),trendWindow({day:'2026-10-16',minutes:5,span:60},now),now);const bar=bars.find(b=>b.time==='2026-10-15T15:00:00.000Z');
 assert.deepEqual([bar.open,bar.high,bar.low,bar.close,bar.count,bar.invalid_count],[100,130,90,110,4,1]);
 const gap=bars.find(b=>b.time==='2026-10-15T14:55:00.000Z');assert.equal(gap.open,null);assert.equal(gap.close,null);assert.equal(gap.count,0);
});
test('1, 5 and 10-minute buckets align to Korea time and identify forming candles',()=>{
 for(const minutes of[1,5,10]){const window=trendWindow({day:'2026-10-16',minutes,span:60},now);assert.equal(window.start%(minutes*60000),0);const bars=aggregateTrend([],window,now);assert.equal(bars.at(-1).complete,false);}
 const past=trendWindow({day:'2026-10-15',minutes:10,span:1440},now);assert.equal(past.end,Date.parse('2026-10-15T15:00:00Z'));assert.equal(aggregateTrend([],past,now).length,144);
});
test('daily index handles duplicate, offline and simultaneous records without losing data',async()=>{
 const store=new MemoryStore(),rows=Array.from({length:6},(_,i)=>record(`2026-10-15T15:0${i}:00Z`,100+i));
 await Promise.all(rows.map(row=>updateTrend(store,row)));await updateTrend(store,rows[0]);
 const data=await getTrend(store,{day:'2026-10-16',minutes:10,span:60},now);assert.equal(data.samples,6);const bar=data.bars.find(b=>b.count);assert.equal(bar.open,100);assert.equal(bar.close,105);assert.equal(Object.keys((await store.get('trend/2026-10-16',{type:'json'})).rows).length,6);
});
test('old history is migrated once; subsequent graph queries read compact summaries',async()=>{
 const store=new MemoryStore(),row=record('2026-10-15T15:01:00Z',234.5);await store.setJSON(`records/2026-10-16/${row.id}`,row);
 let historyReads=0;const get=store.get.bind(store);store.get=async(key,options)=>{if(key.startsWith('records/'))historyReads++;return get(key,options);};
 const options={day:'2026-10-16',minutes:1,span:60};assert.equal((await getTrend(store,options,now)).samples,1);assert.equal(historyReads,1);
 await getTrend(store,options,now);assert.equal(historyReads,1);
});
test('rolling windows include previous-day samples and respect the 30-day boundary',async()=>{
 const store=new MemoryStore();await updateTrend(store,record('2026-10-15T14:50:00Z',200));await updateTrend(store,record('2026-10-15T15:01:00Z',201));
 const data=await getTrend(store,{day:'2026-10-16',minutes:5,span:60},now);assert.equal(data.samples,2);
 assert.equal(trendWindow({day:'2026-09-16',minutes:1,span:60},now).status,410);
 for(const options of[{day:'2026-10-17',minutes:1,span:60},{day:'2026-10-16',minutes:2,span:60},{day:'2026-10-16',minutes:1,span:30}])assert.equal(trendWindow(options,now).status,400);
});
test('public trend API remains empty before collection and rejects expired dates',async()=>{
 const api=createAPI(()=>new MemoryStore());const response=await api(new Request('https://example.invalid/api/trend'));const data=await response.json();assert.equal(response.status,200);assert.equal(data.samples,0);assert.ok(data.bars.every(bar=>bar.open===null));
 assert.equal((await api(new Request('https://example.invalid/api/trend?day=2020-01-01'))).status,410);
});
