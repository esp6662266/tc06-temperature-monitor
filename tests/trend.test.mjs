import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {aggregateTrend,trendWindow,updateTrend,getTrend} from '../server/trend.mjs';import {createAPI} from '../server/api.mjs';import {MemoryStore} from '../server/memory-store.mjs';
const now=Date.parse('2026-10-15T15:10:30.000Z');
function record(time,value=123.4,status='ok'){return{id:randomUUID(),asset:'TC-06',device_id:'synthetic-trend-test',captured_at:time,recorded_at:time,status,value_c:status==='ok'?value:null,confidence:95,source_clock:'00:00:00'};}
const entry=row=>[row.id,[Date.parse(row.captured_at),row.value_c,row.status,Date.parse(row.recorded_at)]];
test('five-minute candles preserve first, high, low, last and failed readings',()=>{
 const rows=[record('2026-10-15T15:04:00Z',110),record('2026-10-15T15:00:00Z',100),record('2026-10-15T15:01:00Z',130),record('2026-10-15T15:02:00Z',0,'ocr_failed'),record('2026-10-15T15:03:00Z',90)];
 const bars=aggregateTrend(rows.map(entry),trendWindow({day:'2026-10-16',minutes:5,span:60},now));const bar=bars.find(b=>b.time==='2026-10-15T15:00:00.000Z');
 assert.deepEqual([bar.open,bar.high,bar.low,bar.close,bar.count,bar.invalid_count],[100,130,90,110,4,1]);
 const gap=bars.find(b=>b.time==='2026-10-15T14:55:00.000Z');assert.equal(gap.open,null);assert.equal(gap.close,null);assert.equal(gap.count,0);
});
test('1, 5 and 10-minute buckets align to Korea time and identify forming candles',()=>{
 for(const minutes of [1,5,10]){
   const window=trendWindow({day:'2026-10-16',minutes,span:60},now);
   assert.equal(window.start,now-3600000);
   assert.equal(window.end,now);
   const bars=aggregateTrend([],window);
   assert.equal(Date.parse(bars[0].time)%(minutes*60000),0);
   assert.equal(bars.at(-1).complete,false);
 }
 const past=trendWindow({day:'2026-10-15',minutes:10,span:1440},now);assert.equal(past.end,Date.parse('2026-10-15T15:00:00Z'));assert.equal(aggregateTrend([],past).length,144);
});
test('candle size does not change the exact query window or its measured and failed totals',async()=>{
 const store=new MemoryStore();
 const rows=[
   record('2026-10-15T14:10:05.000Z',800),
   record('2026-10-15T14:10:29.999Z',0,'ocr_failed'),
   record('2026-10-15T14:10:30.000Z',610),
   record('2026-10-15T14:11:00.000Z',0,'ocr_failed'),
   record('2026-10-15T15:10:29.999Z',600),
   record('2026-10-15T15:10:30.000Z',900),
 ];
 for(const row of rows) await updateTrend(store,row);
 for(const minutes of [1,5,10]){
   const data=await getTrend(store,{day:'2026-10-16',minutes,span:60},now);
   assert.equal(data.start,'2026-10-15T14:10:30.000Z');
   assert.equal(data.end,'2026-10-15T15:10:30.000Z');
   assert.deepEqual([data.samples,data.invalid_samples,data.low,data.high],[2,1,600,610]);
   assert.equal(data.bars[0].open,610);
   assert.equal(data.bars.at(-1).close,600);
 }
});
test('an anchored refresh preserves the earlier window and keeps the last partial candle incomplete',async()=>{
 const store=new MemoryStore();
 const original=await getTrend(store,{day:'2026-10-16',minutes:1,span:60},now);
 const later=now+600000;
 const anchored=await getTrend(store,{day:original.day,minutes:10,span:60,asOf:original.end},later);
 assert.equal(anchored.start,original.start);
 assert.equal(anchored.end,original.end);
 assert.equal(anchored.server_now,new Date(later).toISOString());
 assert.equal(anchored.bars.at(-1).complete,false);
 for(const asOf of ['wrong','2026-10-15T14:59:00.000Z',new Date(later+1).toISOString()]){
   assert.equal(trendWindow({day:original.day,asOf},later).status,400);
 }
});
test('stored collector cadence distinguishes planned blanks from overdue graph buckets',async()=>{
 const store=new MemoryStore();
 for(const time of ['2026-10-15T15:00:00Z','2026-10-15T15:07:00Z']){
   await updateTrend(store,{...record(time),record_interval_seconds:300});
 }
 const data=await getTrend(store,{day:'2026-10-16',minutes:1,span:60},now);
 const stateAt=time=>data.bars.find(bar=>bar.time===time).empty_state;
 assert.equal(stateAt('2026-10-15T15:01:00.000Z'),'scheduled');
 assert.equal(stateAt('2026-10-15T15:05:00.000Z'),'overdue');
 assert.equal(stateAt('2026-10-15T15:07:00.000Z'),undefined);
 assert.equal(stateAt('2026-10-15T15:10:00.000Z'),'pending');
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
test('the trend route accepts a previous end stamp as as_of',async()=>{
 const store=new MemoryStore(),api=createAPI(()=>store);
 const response=await api(new Request('https://example.invalid/api/trend'));
 const original=await response.json();
 const url=new URL('https://example.invalid/api/trend');
 url.search=new URLSearchParams({day:original.day,minutes:'10',as_of:original.end});
 const anchored=await api(new Request(url));
 assert.equal(anchored.status,200);
 assert.equal((await anchored.json()).end,original.end);
});
