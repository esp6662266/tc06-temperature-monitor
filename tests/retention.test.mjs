import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cleanupStore, oldestDay, expired} from '../server/retention.mjs';
import {MemoryStore} from '../server/memory-store.mjs';

const now=Date.parse('2026-10-15T15:10:00.000Z'); // Oct 16, 00:10 Korea.
const old={id:randomUUID(),captured_at:'2026-09-16T14:59:59.000Z'};
const kept={id:randomUUID(),captured_at:'2026-09-16T15:00:00.000Z'};
const fresh={id:randomUUID(),captured_at:'2026-10-15T15:00:00.000Z'};
const key=(day,row)=>`records/${day}/${row.id}`;
test('30 KST calendar dates include the exact midnight boundary',()=>{
 assert.equal(oldestDay(now),'2026-09-17');assert.equal(expired(old,now),true);assert.equal(expired(kept,now),false);
});
test('cleanup removes expired records and legacy audio, preserves retained and unrelated keys',async()=>{
 const store=new MemoryStore();await store.setJSON(key('2026-09-16',old),old);await store.setJSON(key('2026-09-17',kept),kept);await store.setJSON(key('2026-10-16',fresh),fresh);await store.setJSON('latest',old);
 await store.set('audio/'+'a'.repeat(64),'legacy');await store.set('audio/notice-stale','legacy');await store.set('other/preserve','unknown');await store.set('records/2026-09-16/do-not-delete-unknown','unknown');
 const result=await cleanupStore(store,{now});assert.equal(result.deleted_records,1);assert.equal(result.deleted_audio,2);assert.equal(result.cleared_latest,true);assert.equal(await store.get('latest',{type:'json'}),null);
 assert.ok(await store.get(key('2026-09-17',kept)));assert.ok(await store.get(key('2026-10-16',fresh)));assert.equal(await store.get('other/preserve'),'unknown');assert.equal(await store.get('records/2026-09-16/do-not-delete-unknown'),'unknown');
 assert.equal((await store.get('maintenance/retention',{type:'json'})).retention_days,30);
 const again=await cleanupStore(store,{now});assert.equal(again.deleted_records,0);assert.equal(again.deleted_audio,0);
});
test('bounded cleanup resumes on the next run',async()=>{
 const store=new MemoryStore();for(let i=0;i<5;i++)await store.setJSON(key('2026-09-16',{id:randomUUID()}),old);
 const first=await cleanupStore(store,{now,limit:2});assert.equal(first.deleted_records,2);assert.equal(first.limit_reached,true);
 const next=await cleanupStore(store,{now});assert.equal(next.deleted_records,3);
});
test('clearing an expired latest cannot overwrite a simultaneous new upload',async()=>{
 const store=new MemoryStore();await store.setJSON('latest',old);const get=store.getWithMetadata.bind(store);
 store.getWithMetadata=async(...args)=>{const result=await get(...args);if(args[0]==='latest')await store.setJSON('latest',fresh);return result;};
 const result=await cleanupStore(store,{now});assert.equal(result.cleared_latest,false);assert.deepEqual(await store.get('latest',{type:'json'}),fresh);
});
test('graph summary retention matches the records policy',async()=>{
 const store=new MemoryStore();await store.setJSON('trend/2026-09-16',{rows:{old:'expired'}});await store.setJSON('trend/2026-09-17',{rows:{kept:'retained'}});await store.set('trend/unknown-key','unknown');
 const result=await cleanupStore(store,{now});assert.equal(result.deleted_trends,1);assert.equal(await store.get('trend/2026-09-16'),null);assert.ok(await store.get('trend/2026-09-17'));assert.equal(await store.get('trend/unknown-key'),'unknown');
});
test('last normal state is removed on expiry but a simultaneous newer normal is preserved',async()=>{
 const store=new MemoryStore();await store.setJSON('last-good',old);assert.equal((await cleanupStore(store,{now})).cleared_last_good,true);assert.equal(await store.get('last-good',{type:'json'}),null);
 await store.setJSON('last-good',old);const get=store.getWithMetadata.bind(store);store.getWithMetadata=async(...args)=>{const result=await get(...args);if(args[0]==='last-good')await store.setJSON('last-good',fresh);return result;};
 assert.equal((await cleanupStore(store,{now})).cleared_last_good,false);assert.deepEqual(await store.get('last-good',{type:'json'}),fresh);
});
