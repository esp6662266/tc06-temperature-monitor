import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { PUBLIC_KEY } from './update-trust.mjs';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f-]{36}$/;
const STATES = new Set(['idle','downloading','ready','switching','completed','rolled_back','failed']);
const REPO = 'https://github.com/esp6662266/tc06-temperature-monitor';
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
const token = request => request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)?.[1] || '';
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
const newer = (left, right) => {
  const a=left.split('.').map(Number),b=right.split('.').map(Number);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return false;
};
const reply = (data, status=200) => new Response(JSON.stringify(data),{status,headers:{
  'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
  'Netlify-CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

export async function cleanupUpdates(store, now=Date.now()) {
  let deleted=0;
  for(const prefix of ['nonces/','rate/','audit/']){
    for await(const page of store.list({prefix,paginate:true}))for(const item of page.blobs||[]){
      if(deleted>=500)return {deleted,limited:true};
      const value=await store.get(item.key,{type:'json'});
      const expired=prefix==='nonces/'?value?.expires_at<now-3600_000:
        prefix==='rate/'?Number(item.key.slice(5))<Math.floor(now/60_000)-120:
        (value?.finished_at||value?.requested_at||now)<now-30*86400_000;
      if(expired){await store.delete(item.key);deleted++;}
    }
  }
  return {deleted,limited:false};
}

export function verifyRelease(envelope, publicKey=PUBLIC_KEY) {
  if(!envelope || typeof envelope.payload!=='string' || typeof envelope.signature!=='string' || envelope.payload.length>6000)throw Error('Invalid signed release');
  const raw=Buffer.from(envelope.payload,'base64');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(publicKey,'base64')]),type:'spki',format:'der'});
  if(!verify(null,raw,key,Buffer.from(envelope.signature,'base64')))throw Error('Invalid release signature');
  const data=JSON.parse(raw.toString('utf8'));
  if(!version(data.version)||data.url!==`${REPO}/releases/download/v${data.version}/TC06Monitor-Portable-${data.version}-x64.zip` ||
    !/^[a-f0-9]{64}$/.test(data.sha256)||!Number.isSafeInteger(data.size)||data.size<1||data.size>300_000_000||
    !Number.isSafeInteger(data.unpacked_size)||data.unpacked_size<1||data.unpacked_size>900_000_000)throw Error('Unapproved release');
  return data;
}

async function body(request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Error('JSON required');
  let size=0;const chunks=[],reader=request.body?.getReader();
  if(!reader)throw Error('Body required');
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>16_384){await reader.cancel();throw Error('Body too large');}chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function mutate(store,key,change) {
  for(let i=0;i<8;i++){
    const previous=await store.getWithMetadata(key,{type:'json',consistency:'strong'});
    const value=await change(previous?.data);
    const outcome=await store.setJSON(key,value,previous?{onlyIfMatch:previous.etag}:{onlyIfNew:true});
    if(outcome.modified)return value;
  }
  throw Error('Concurrent change; refresh and retry');
}

export function createUpdates(getStore,{adminToken=()=>process.env.TC06_UPDATE_ADMIN_TOKEN||'',now=()=>Date.now(),publicKey=PUBLIC_KEY}={}) {
  return async request => {
    try {
      const url=new URL(request.url);
      const parts=url.pathname.replace(/^\/\.netlify\/functions\/updates/,'/api/updates').split('/').filter(Boolean);
      if(parts[0]!=='api'||parts[1]!=='updates')return reply({error:'Not found'},404);
      const origin=request.headers.get('Origin');
      if(origin && origin!==url.origin)return reply({error:'Origin refused'},403);
      if(!['GET','POST'].includes(request.method))return reply({error:'Method refused'},405);
      const secret=adminToken();
      if(!/^[A-Za-z0-9_-]{40,100}$/.test(secret))return reply({error:'업데이트 관리 연결 전'},503);
      const store=getStore(),time=now();
      if(parts[2]==='admin') {
        if(!token(request)||!equal(token(request),secret))return reply({error:'관리자 인증을 확인하세요'},401);
        if(request.method==='GET' && parts[3]==='overview'){
          const devices=[];
          for await(const page of store.list({prefix:'devices/',paginate:true}))for(const item of page.blobs||[]){
            const device=await store.get(item.key,{type:'json'});
            if(device && !device.revoked){const {token_hash,...safe}=device;devices.push({...safe,online:time-device.seen_at<60_000});}
          }
          return reply({devices,server_now:time});
        }
        if(request.method==='GET' && parts[3]==='nonce'){
          const nonce=randomBytes(24).toString('hex');
          await store.setJSON('nonces/'+digest(nonce),{expires_at:time+120_000});
          return reply({nonce});
        }
        if(request.method!=='POST')return reply({error:'Method refused'},405);
        // Single-use nonce prevents replay; bearer auth is never sent in cookies or URLs.
        const nonce=request.headers.get('X-Update-Nonce')||'';
        if(!/^[a-f0-9]{48}$/.test(nonce))return reply({error:'Refresh authorization'},403);
        const nonceKey='nonces/'+digest(nonce),entry=await store.getWithMetadata(nonceKey,{type:'json'});
        if(!entry || entry.data.used || entry.data.expires_at<time)return reply({error:'Expired authorization'},403);
        if(!(await store.setJSON(nonceKey,{...entry.data,used:true},{onlyIfMatch:entry.etag})).modified)return reply({error:'Replayed authorization'},409);
        const rateKey='rate/'+Math.floor(time/60_000);
        await mutate(store,rateKey,value=>{const count=(value?.count||0)+1;if(count>30)throw Error('Update rate limit');return {count};});
        const input=await body(request);
        if(!ID.test(input.device_id||''))throw Error('Invalid device identifier');
        const key='devices/'+input.device_id;
        if(parts[3]==='pair'){
          const deviceToken=randomBytes(32).toString('base64url');
          const device={device_id:input.device_id,token_hash:digest(deviceToken),paired_at:time,seen_at:0,status:'idle',version:null,command:null,available:null};
          // Re-pairing requires explicit revocation, never silently disconnect an active PC.
          await mutate(store,key,previous=>{if(previous&&!previous.revoked)throw Error('Device already paired');return device;});
          return reply({device_id:input.device_id,token:deviceToken});
        }
        if(parts[3]==='revoke'){
          await mutate(store,key,previous=>{if(!previous)throw Error('Unknown device');return {...previous,revoked:true,command:null};});
          return reply({revoked:true});
        }
        if(parts[3]==='command'){
          const commandId=randomUUID();
          const saved=await mutate(store,key,device=>{
            if(!device||device.revoked||time-device.seen_at>=60_000)throw Error('Device is offline or not paired');
            if(!version(device.version)||!device.available)throw Error('No verified release available');
            const release=verifyRelease(device.available.envelope,publicKey);
            if(!newer(release.version,device.version))throw Error('Already on latest version');
            if(device.command && (device.command.state==='claimed'||device.command.expires_at>time))throw Error('Update already requested');
            if(time-(device.requested_at||0)<60_000)throw Error('Wait before requesting another update');
            return {...device,requested_at:time,command:{id:commandId,device_id:input.device_id,nonce:randomBytes(16).toString('hex'),
              created_at:time,expires_at:time+600_000,state:'queued',manifest:device.available.envelope,version:release.version}};
          });
          await store.setJSON('audit/'+commandId,{device_id:input.device_id,requested_at:time,version:saved.command.version,state:'queued'});
          return reply({command:saved.command});
        }
        return reply({error:'Not found'},404);
      }
      if(parts[2]==='device' && ID.test(parts[3]||'') && request.method==='POST'){
        const key='devices/'+parts[3],device=await store.get(key,{type:'json'});
        if(!device||device.revoked||!token(request)||!equal(digest(token(request)),device.token_hash))return reply({error:'Device authorization refused'},401);
        const input=await body(request);
        if(parts[4]==='claim'){
          const claimed=await mutate(store,key,current=>{
            if(current.revoked||current.token_hash!==device.token_hash)throw Error('Device pairing changed');
            if(!current.command||current.command.id!==input.command_id||current.command.state!=='queued'||current.command.expires_at<=time)throw Error('Command already claimed or expired');
            return {...current,command:{...current.command,state:'claimed',claimed_at:time},status:'downloading'};
          });
          return reply({command:claimed.command});
        }
        if(parts[4]==='ready'){
          await mutate(store,key,current=>{
            if(current.revoked||current.token_hash!==device.token_hash||current.command?.id!==input.command_id||current.command.state!=='claimed'||current.command.expires_at<=time)throw Error('Update no longer authorized');
            return {...current,status:'ready'};
          });
          return reply({authorized:true});
        }
        if(parts[4]==='heartbeat'){
          if(!version(input.version)||!STATES.has(input.status))throw Error('Invalid agent state');
          let available=null;
          if(input.available){const release=verifyRelease(input.available.envelope,publicKey);available={version:release.version,envelope:input.available.envelope};}
          const saved=await mutate(store,key,current=>{
            if(current.revoked||current.token_hash!==device.token_hash)throw Error('Device pairing changed');
            const result={...current,seen_at:time,version:input.version,status:input.status};
            if(input.result && input.command_id && input.result.command_id===input.command_id && current.command?.id===input.command_id &&
              Number.isFinite(input.result.gap_seconds) && input.result.gap_seconds>=0 && input.result.gap_seconds<86400){
              result.result={command_id:input.command_id,gap_seconds:input.result.gap_seconds};
            }
            if(available)result.available=available;
            if(input.command_id && UUID.test(input.command_id) && current.command?.id===input.command_id && current.command.state==='claimed'){
              if(['completed','rolled_back','failed'].includes(input.status))result.command={...current.command,state:input.status,finished_at:time};
            }
            return result;
          });
          if(saved.command && ['completed','rolled_back','failed'].includes(saved.command.state))await store.setJSON('audit/'+saved.command.id,
            {device_id:parts[3],requested_at:saved.command.created_at,finished_at:saved.command.finished_at,version:saved.command.version,state:saved.command.state});
          return reply({server_now:time,command:saved.command?.state==='queued'&&saved.command.expires_at>time?saved.command:null});
        }
      }
      return reply({error:'Not found'},404);
    }catch(error){
      // No request payloads, tokens or arbitrary exception strings in responses/logs.
      return reply({error:'요청을 적용하지 못했습니다. 연결 상태·버전·진행 중인 업데이트를 확인하세요.'},409);
    }
  };
}
