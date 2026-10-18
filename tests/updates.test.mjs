import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createUpdates, verifyRelease } from '../server/updates.mjs';
import { MemoryStore } from '../server/memory-store.mjs';

const admin='A'.repeat(43),deviceId='synthetic-pc';
function setup(){
 const store=new MemoryStore();let time=Date.now();const keys=generateKeyPairSync('ed25519');
 const publicKey=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
 const api=createUpdates(()=>store,{adminToken:()=>admin,now:()=>time,publicKey});
 const payload=Buffer.from(JSON.stringify({version:'0.6.1',url:'https://github.com/esp6662266/tc06-temperature-monitor/releases/download/v0.6.1/TC06Monitor-Portable-0.6.1-x64.zip',size:1000,unpacked_size:2000,sha256:'a'.repeat(64)}));
 const envelope={payload:payload.toString('base64'),signature:sign(null,payload,keys.privateKey).toString('base64')};
 const call=async(path,{auth=admin,data,nonce,origin}={})=>api(new Request('https://tc06.test/api/updates/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+auth,...(data?{'Content-Type':'application/json'}:{}),...(nonce?{'X-Update-Nonce':nonce}:{}),...(origin?{Origin:origin}:{})},body:data?JSON.stringify(data):undefined}));
 const adminPost=async(action,data)=>{const n=await(await call('admin/nonce')).json();return call('admin/'+action,{data,nonce:n.nonce});};
 const pair=async()=>{const r=await adminPost('pair',{device_id:deviceId});assert.equal(r.status,200);return (await r.json()).token;};
 const heartbeat=(token,extra={})=>call('device/'+deviceId+'/heartbeat',{auth:token,data:{version:'0.6.0',status:'idle',available:{envelope},...extra}});
 return {store,api,call,adminPost,pair,heartbeat,envelope,publicKey,advance:ms=>time+=ms};
}

test('update routes are disabled without configuration; wrong credentials and foreign origin denied',async()=>{
 const disabled=createUpdates(()=>new MemoryStore(),{adminToken:()=>''});assert.equal((await disabled(new Request('https://tc06.test/api/updates/admin/overview'))).status,503);
 const s=setup();assert.equal((await s.call('admin/overview',{auth:'B'.repeat(43)})).status,401);
 assert.equal((await s.call('admin/overview',{origin:'https://evil.example'})).status,403);
 assert.equal((await s.call('admin/pair',{data:{device_id:deviceId}})).status,403);
});

test('pairing issues unique scoped tokens and never exposes token hashes in overview',async()=>{
 const s=setup(),token=await s.pair();assert.match(token,/^[A-Za-z0-9_-]{43}$/);
 assert.equal((await s.heartbeat(token)).status,200);
 const overview=await(await s.call('admin/overview')).json();assert.equal(overview.devices[0].online,true);
 assert.ok(!JSON.stringify(overview).includes(token));assert.ok(!JSON.stringify(overview).includes('token_hash'));
 assert.equal((await s.adminPost('pair',{device_id:deviceId})).status,409);
 assert.equal((await s.call('device/other-pc/heartbeat',{auth:token,data:{version:'0.6.0',status:'idle'}})).status,401);
});

test('signed releases reject tampering and unofficial URL before issuing commands',async()=>{
 const s=setup();assert.equal(verifyRelease(s.envelope,s.publicKey).version,'0.6.1');
 const invalid={...s.envelope,payload:Buffer.from('{}').toString('base64')};assert.throws(()=>verifyRelease(invalid,s.publicKey));
 const token=await s.pair();assert.equal((await s.heartbeat(token,{available:{envelope:invalid}})).status,409);
 assert.equal((await s.adminPost('command',{device_id:deviceId})).status,409);
});

test('one administrator command and one agent claim win concurrent requests',async()=>{
 const s=setup(),token=await s.pair();await s.heartbeat(token);
 const results=await Promise.all([s.adminPost('command',{device_id:deviceId}),s.adminPost('command',{device_id:deviceId})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const queued=(await(await s.heartbeat(token)).json()).command;assert.equal(queued.state,'queued');
 const claims=await Promise.all([1,2].map(()=>s.call('device/'+deviceId+'/claim',{auth:token,data:{command_id:queued.id}})));
 assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);
 assert.equal((await(await s.heartbeat(token)).json()).command,null);
 await s.heartbeat(token,{status:'completed',command_id:queued.id,version:'0.6.1'});
 const device=(await(await s.call('admin/overview')).json()).devices[0];assert.equal(device.command.state,'completed');
 assert.equal((await s.store.get('audit/'+queued.id,{type:'json'})).state,'completed');
});

test('expired commands never reach or execute on the agent; offline agents cannot be targeted',async()=>{
 const s=setup(),token=await s.pair();await s.heartbeat(token);const response=await s.adminPost('command',{device_id:deviceId});
 const {command}=await response.json();s.advance(601_000);
 assert.equal((await(await s.heartbeat(token)).json()).command,null);
 assert.equal((await s.call('device/'+deviceId+'/claim',{auth:token,data:{command_id:command.id}})).status,409);
 s.advance(61_000);assert.equal((await s.adminPost('command',{device_id:deviceId})).status,409);
});

test('single-use admin authorization cannot be replayed, and revocation blocks previous agent',async()=>{
 const s=setup(),nonce=(await(await s.call('admin/nonce')).json()).nonce;
 const first=await s.call('admin/pair',{data:{device_id:deviceId},nonce});const {token}=await first.json();
 assert.equal((await s.call('admin/revoke',{data:{device_id:deviceId},nonce})).status,403);
 await s.adminPost('revoke',{device_id:deviceId});assert.equal((await s.heartbeat(token)).status,401);
});

test('same-version releases never apply and malformed/oversize state remains rejected',async()=>{
 const s=setup(),token=await s.pair();await s.heartbeat(token,{version:'0.6.1'});
 assert.equal((await s.adminPost('command',{device_id:deviceId})).status,409);
 assert.equal((await s.heartbeat(token,{version:'1;rm',status:'idle'})).status,409);
 assert.equal((await s.heartbeat(token,{status:'x'.repeat(17000)})).status,409);
});

test('revoking an update during download prevents the final ready authorization',async()=>{
 const s=setup(),token=await s.pair();await s.heartbeat(token);const {command}=await(await s.adminPost('command',{device_id:deviceId})).json();
 await s.call('device/'+deviceId+'/claim',{auth:token,data:{command_id:command.id}});
 assert.equal((await s.call('device/'+deviceId+'/ready',{auth:token,data:{command_id:command.id}})).status,200);
 await s.adminPost('revoke',{device_id:deviceId});
 assert.equal((await s.call('device/'+deviceId+'/ready',{auth:token,data:{command_id:command.id}})).status,401);
});

test('update cleanup removes only expired nonces, rate counters and old audit, preserving device pairing',async()=>{
 const {cleanupUpdates}=await import('../server/updates.mjs');const store=new MemoryStore(),now=Date.now();
 await store.setJSON('devices/pc',{token_hash:'synthetic pairing'});
 await store.setJSON('nonces/old',{expires_at:now-7200_000});await store.setJSON('nonces/new',{expires_at:now+120_000});
 await store.setJSON('audit/old',{requested_at:now-31*86400_000});
 await store.setJSON('rate/'+(Math.floor(now/60_000)-121),{count:1});
 assert.equal((await cleanupUpdates(store,now)).deleted,3);
 assert.ok(await store.get('devices/pc'));assert.ok(await store.get('nonces/new'));
});

test('an ambiguous failed claim is terminal and cannot later be claimed or reported completed',async()=>{
 const s=setup(),token=await s.pair();await s.heartbeat(token);const {command}=await(await s.adminPost('command',{device_id:deviceId})).json();
 await s.heartbeat(token,{status:'failed',command_id:command.id});
 assert.equal((await s.call('device/'+deviceId+'/claim',{auth:token,data:{command_id:command.id}})).status,409);
 await s.heartbeat(token,{status:'completed',command_id:command.id});
 assert.equal((await(await s.call('admin/overview')).json()).devices[0].command.state,'failed');
});
