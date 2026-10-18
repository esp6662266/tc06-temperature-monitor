const $=id=>document.getElementById(id);
let credential='',timer=null,selection=null,busy=false;
const states={idle:'대기',downloading:'다운로드·검증 중',ready:'교체 준비',switching:'수집기 교체 중',completed:'업데이트 완료',rolled_back:'이전 버전으로 복구됨',failed:'업데이트 실패',queued:'실행 요청 대기',claimed:'적용 진행 중'};
const newer=(left,right)=>{if(!left||!right)return false;const a=left.split('.').map(Number),b=right.split('.').map(Number);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;};
function notice(text){$('notice').textContent=text;}
async function api(action,data){
  const headers={Authorization:'Bearer '+credential};
  if(data){const nonce=await api('nonce');headers['X-Update-Nonce']=nonce.nonce;headers['Content-Type']='application/json';}
  const response=await fetch('/api/updates/admin/'+action,{method:data?'POST':'GET',headers,body:data?JSON.stringify(data):undefined,cache:'no-store',redirect:'error'});
  const result=await response.json();if(!response.ok)throw Error(result.error||'업데이트 관리 서버를 확인하세요.');return result;
}
function text(tag,content,className){const element=document.createElement(tag);element.textContent=content;if(className)element.className=className;return element;}
function render(devices){
  $('devices').replaceChildren();$('empty').hidden=devices.length>0;
  for(const device of devices){
    const article=document.createElement('article');article.className='device';
    const info=document.createElement('div');info.append(text('h3',device.device_id));
    info.append(text('p',device.online?'현장 PC 연결됨':'현장 PC 응답 없음'));
    const versions=document.createElement('div');versions.className='versions';
    for(const [label,value]of[['현재 버전',device.version||'연결 전'],['배포 버전',device.available?.version||'확인 전']]){const item=text('span',label);item.append(text('strong',value));versions.append(item);}
    info.append(versions);
    const state=device.command?.state||device.status;
    const expired=state==='queued'&&device.command.expires_at<=Date.now();
    info.append(text('p',expired?'업데이트 요청 만료 · 다시 요청하세요':states[state]||'상태 확인 필요'));
    if(device.result&&['completed','rolled_back'].includes(state))info.append(text('p',`프로그램 교체·확인에 걸린 시간 ${device.result.gap_seconds}초`));
    info.append(text('p',device.seen_at?'마지막 응답 '+new Date(device.seen_at).toLocaleString('ko-KR'):'수집기에서 연결 코드를 입력하세요.'));
    const actions=document.createElement('div');actions.className='actions';
    const apply=text('button','업데이트 적용');
    const inProgress=device.command&&['queued','claimed'].includes(device.command.state)&&
      (device.command.state==='claimed'||device.command.expires_at>Date.now());
    apply.disabled=!device.online||!newer(device.available?.version,device.version)||!!inProgress||busy;
    apply.onclick=()=>{selection=device;$('confirm-text').textContent=`${device.device_id}: ${device.version} → ${device.available.version}`;$('confirmation').hidden=false;$('apply').focus();};
    actions.append(apply);
    const revoke=text('button','연결 해제');revoke.className='secondary';
    revoke.onclick=async()=>{try{await api('revoke',{device_id:device.device_id});notice(device.device_id+'의 업데이트 연결을 해제했습니다. 온도 수집은 계속됩니다.');await refresh(false);}catch(error){notice(error.message);}};
    actions.append(revoke);article.append(info,actions);$('devices').append(article);
  }
}
async function refresh(announce=true){
  try{const result=await api('overview');$('workspace').hidden=false;$('login').hidden=true;render(result.devices);if(announce)notice('현장 PC 상태를 확인했습니다. 새 버전이 있어도 직접 실행하기 전에는 적용하지 않습니다.');}
  catch(error){for(const button of $('devices').querySelectorAll('button'))button.disabled=true;$('confirmation').hidden=true;selection=null;notice(error.message);throw error;}
}
$('login').onsubmit=async event=>{event.preventDefault();credential=$('admin-token').value.trim();try{await refresh();$('admin-token').value='';clearInterval(timer);timer=setInterval(()=>refresh(false).catch(()=>{}),15_000);}catch{credential='';}};
$('refresh').onclick=()=>refresh().catch(()=>{});
$('logout').onclick=()=>{credential='';clearInterval(timer);selection=null;$('workspace').hidden=true;$('login').hidden=false;$('devices').replaceChildren();$('pair-token').value='';$('pair-result').hidden=true;$('confirmation').hidden=true;notice('업데이트 관리자 연결을 해제했습니다.');};
$('cancel').onclick=()=>{selection=null;$('confirmation').hidden=true;};
$('apply').onclick=async()=>{if(!selection||busy)return;busy=true;$('apply').disabled=true;try{await api('command',{device_id:selection.device_id});notice(selection.device_id+'에 업데이트를 요청했습니다. 현장 PC 응답을 기다립니다.');selection=null;$('confirmation').hidden=true;await refresh(false);}catch(error){notice(error.message);}finally{busy=false;$('apply').disabled=false;}};
$('pair').onsubmit=async event=>{event.preventDefault();try{const result=await api('pair',{device_id:$('device-id').value.trim()});$('pair-token').value=result.token;$('pair-result').hidden=false;notice('PC 연결 코드를 발급했습니다. 수집기의 원격 업데이트 연결에 입력하세요.');await refresh(false);}catch(error){notice(error.message);}};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('pair-token').value);notice('PC 연결 코드를 복사했습니다.');}catch{ $('pair-token').select();notice('연결 코드를 선택했습니다. 복사해서 사용하세요.');}};
