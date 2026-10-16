import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateAt,estimateFailures,MAX_ESTIMATE_MS} from '../server/estimate.mjs';
import {currentEstimate,createAPI} from '../server/api.mjs';
import {updateTrend,getTrend,readDay} from '../server/trend.mjs';
import {dayKST} from '../server/retention.mjs';
import {MemoryStore} from '../server/memory-store.mjs';
import {randomUUID} from 'node:crypto';
const base=Date.parse('2026-10-16T03:00:00Z');
function series(values=[590,595,600],end=base,device='synthetic-estimate') {return values.map((value,i)=>[randomUUID(),[end-(values.length-1-i)*60000,value,'ok',end-(values.length-1-i)*60000,device]]);}
const row=entry=>({id:entry[0],asset:'TC-06',device_id:entry[1][4],captured_at:new Date(entry[1][0]).toISOString(),recorded_at:new Date(entry[1][3]).toISOString(),status:entry[1][2],value_c:entry[1][1],source_clock:'12:00:00',confidence:95});
const failed=(at,status='ocr_failed',device='synthetic-estimate')=>[randomUUID(),[at,null,status,at,device]];

test('steady recent measurements yield a separate forecast for no longer than two minutes',()=>{
 const entries=series(),before=JSON.stringify(entries),one=estimateAt(entries,base+60000,'synthetic-estimate');
 assert.equal(one.value_c,605);assert.equal(one.sample_count,3);assert.equal(one.based_on_at,new Date(base).toISOString());assert.equal(one.estimated,true);assert.equal(one.expires_at,new Date(base+MAX_ESTIMATE_MS).toISOString());
 assert.equal(estimateAt(entries,base+120000,'synthetic-estimate').value_c,610);assert.equal(estimateAt(entries,base+120001,'synthetic-estimate'),null);assert.equal(JSON.stringify(entries),before);
});
test('flat, falling and thousand-degree series preserve sign and decimal precision',()=>{
 for(const [values,expected]of [[[600,600,600],600],[[610,605,600],595],[[989.9,994.9,999.9],1004.9],[[-5,-4,-3],-2]])assert.equal(estimateAt(series(values),base+60000,'synthetic-estimate').value_c,expected);
});
test('insufficient, erratic, gapped, duplicate-time and mixed-source evidence is rejected',()=>{
 assert.equal(estimateAt(series([595,600]),base+60000,'synthetic-estimate'),null);
 assert.equal(estimateAt(series([600,620,601]),base+60000,'synthetic-estimate'),null);
 const gapped=series();gapped[0][1][0]-=60000;assert.equal(estimateAt(gapped,base+60000,'synthetic-estimate'),null);
 const duplicate=series();duplicate[0][1][0]=duplicate[1][1][0];assert.equal(estimateAt(duplicate,base+60000,'synthetic-estimate'),null);
 const mixed=series();mixed[1][1][4]='other';assert.equal(estimateAt(mixed,base+60000,'synthetic-estimate'),null);
 assert.equal(estimateAt(series(),base+60000,'other'),null);assert.equal(estimateAt(series(),base+60000,'synthetic-estimate','wrong-anchor'),null);
});
test('future measurements, old device-less indexes and out-of-range predictions cannot produce a value',()=>{
 assert.equal(estimateAt(series(),base-30000,'synthetic-estimate'),null);
 assert.equal(estimateAt(series().map(([id,data])=>[id,data.slice(0,4)]),base+60000,'synthetic-estimate'),null);
 assert.equal(estimateAt(series([9980,9990,9999.9]),base+60000,'synthetic-estimate'),null);
});
test('historical forecasts use only past normals and explicit OCR failures, leaving missing slots empty',()=>{
 const entries=[...series(),failed(base+60000),failed(base+120000),failed(base+180000),failed(base+20000,'stale_source')];
 const window={start:base,end:base+240000},result=estimateFailures(entries,window);
 assert.deepEqual(result.map(item=>item.value_c),[605,610]);assert.equal(result[0].source_status,'ocr_failed');
 assert.equal(estimateFailures(series(),window).length,0);
 const future=[failed(base),...series([590,595,600],base+180000)];assert.equal(estimateFailures(future,window).length,0);
});
test('latest forecast requires an explicit newer OCR failure from the same collector',async()=>{
 const store=new MemoryStore(),entries=series(),last=row(entries.at(-1)),bad=row(failed(base+60000));for(const entry of entries)await updateTrend(store,row(entry));
 assert.equal((await currentEstimate(store,bad,last,base+90000)).value_c,607.5);
 for(const status of ['ok','source_error','stale_source','freshness_unverified','window_missing'])assert.equal(await currentEstimate(store,{...bad,status},last,base+90000),null);
 assert.equal(await currentEstimate(store,{...bad,device_id:'other'},last,base+90000),null);assert.equal(await currentEstimate(store,bad,last,base+120001),null);
});
test('public API forecasts never alter raw failures, last normal values or CSV history',async()=>{
 const now=Date.now(),entries=series([590,595,600],now-80000),bad=row(failed(now-20000)),store=new MemoryStore(),api=createAPI(()=>store);
 for(const record of [...entries.map(row),bad]){const response=await api(new Request('https://example.invalid/api/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({record})}));assert.equal(response.status,200);}
 const before=[...store.data.entries()].filter(([key])=>key.startsWith('records/')).map(([key,value])=>[key,value.value]);
 const response=await api(new Request('https://example.invalid/api/latest')),data=await response.json();assert.equal(response.status,200);assert.equal(data.record.value_c,null);assert.equal(data.record.status,'ocr_failed');assert.equal(data.last_good.value_c,600);assert.ok(data.estimate.value_c>=606.6&&data.estimate.value_c<=607);
 const csv=await(await api(new Request('https://example.invalid/api/history?day='+dayKST(now)))).text();assert.equal(csv.split('\r\n').length,5);assert.ok(csv.includes('ocr_failed'));assert.equal(csv.includes('recent_linear_v1'),false);
 assert.deepEqual([...store.data.entries()].filter(([key])=>key.startsWith('records/')).map(([key,value])=>[key,value.value]),before);
});
test('optional forecasting store errors do not hide the latest record',async()=>{
 const now=Date.now(),store=new MemoryStore(),entries=series([590,595,600],now-80000),last=row(entries.at(-1)),bad=row(failed(now-20000));await store.setJSON('latest',bad);await store.setJSON('last-good',last);const get=store.get.bind(store);store.get=async(key,options)=>{if(key.startsWith('trend/'))throw Error('forecast unavailable');return get(key,options);};
 const response=await createAPI(()=>store)(new Request('https://example.invalid/api/latest'));assert.equal(response.status,200);assert.equal((await response.json()).estimate,null);
});
test('index version one upgrades device evidence once while preserving canonical measurements',async()=>{
 const store=new MemoryStore(),entries=series();for(const entry of entries)await store.setJSON('records/'+dayKST(base)+'/'+entry[0],row(entry));
 await store.setJSON('trend/'+dayKST(base),{version:1,day:dayKST(base),complete:true,rows:Object.fromEntries(entries.map(([id,data])=>[id,data.slice(0,4)]))});
 let reads=0;const get=store.get.bind(store);store.get=async(key,options)=>{if(key.startsWith('records/'))reads++;return get(key,options);};
 const migrated=await readDay(store,dayKST(base));assert.equal(migrated.version,2);assert.ok(Object.values(migrated.rows).every(tuple=>tuple[4]==='synthetic-estimate'));assert.equal(reads,3);await readDay(store,dayKST(base));assert.equal(reads,3);
});
test('1/5/10-minute graphs expose forecasts separately from measured candles and extrema',async()=>{
 const store=new MemoryStore();for(const entry of [...series(),failed(base+60000)])await updateTrend(store,row(entry));
 for(const minutes of [1,5,10]){const data=await getTrend(store,{day:dayKST(base),minutes,span:60},base+90000);assert.equal(data.estimates.length,1);assert.equal(data.estimates[0].value_c,605);assert.equal(data.samples,3);assert.equal(data.invalid_samples,1);assert.equal(data.high,600);assert.equal(data.low,590);assert.equal(data.bars.reduce((sum,bar)=>sum+bar.count,0),3);}
});
test('forecast context spans midnight and a 24-hour chart can read three KST dates',async()=>{
 const at=Date.parse('2026-10-15T15:00:30Z'),store=new MemoryStore(),entries=series([590,595,600],at-60000);for(const entry of [...entries,failed(at)])await updateTrend(store,row(entry));
 const last=row(entries.at(-1));assert.equal((await currentEstimate(store,row(failed(at)),last,at+10000)).value_c,605.8);
 const data=await getTrend(store,{day:'2026-10-16',minutes:1,span:1440},at+10000);assert.equal(data.samples,3);assert.equal(data.estimates.length,1);
});
