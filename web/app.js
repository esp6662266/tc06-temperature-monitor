'use strict';
const byId = id => document.getElementById(id);
const voice = new TC06Voice.NumberVoice();
const PALETTES={
 white:{fg:'#ffffff',bg:'#000000',label:'검정 · 흰색'},
 amber:{fg:'#ffe600',bg:'#000000',label:'검정 · 노랑 ★'},
 mint:{fg:'#55e5b6',bg:'#000000',label:'검정 · 민트'},
 cyan:{fg:'#00e5ff',bg:'#000000',label:'검정 · 하늘색'},
 orange:{fg:'#ffb347',bg:'#000000',label:'검정 · 주황'},
 navy:{fg:'#ffffff',bg:'#061a35',label:'남색 · 흰색'},
 yellow:{fg:'#000000',bg:'#ffe600',label:'노랑 · 검정'}
};
let settings={volume:0.8,interval:60,color:'white',customColor:'#ffffff',size:90};
try { Object.assign(settings,JSON.parse(localStorage.getItem('tc06-settings-v2')||'{}')); } catch { /* Storage may be disabled on TV. */ }
settings.volume=Math.max(0,Math.min(1,Number(settings.volume)||0));
settings.interval=[60,120,300].includes(Number(settings.interval))?Number(settings.interval):60;
settings.color=[...Object.keys(PALETTES),'custom'].includes(settings.color)?settings.color:'white';
settings.customColor=/^#[0-9a-f]{6}$/i.test(settings.customColor)?settings.customColor:'#ffffff';
settings.size=Math.max(50,Math.min(100,Number(settings.size)||90));
let latest=null,serverOffset=0,networkOK=false,lookupDone=false,enabled=false,nextAnnouncement=0,announcing=false,refreshPromise=null;
let menuTimer=null,graph=null;
let lastNormal=null,lastKind=null,serverEstimate=null;
try{lastNormal=JSON.parse(localStorage.getItem('tc06-last-good-v1')||'null');}catch{}
const labels={ocr_timeout:'판독 시간이 초과되어 다시 읽는 중입니다',anchor_missing:'TC-06을 찾을 수 없습니다',ambiguous_anchor:'TC-06 표시가 여러 개입니다',occluded:'온도 영역이 다른 창에 가려졌습니다',ocr_failed:'온도를 판독할 수 없습니다',value_suspect:'숫자 재확인이 필요합니다',low_confidence:'숫자가 선명하지 않습니다',freshness_unverified:'원본 시계의 진행을 확인 중입니다',stale_source:'원본 영상 정지가 의심됩니다',source_error:'영상 입력을 확인해 주세요',window_missing:'HMI 창을 확인해 주세요'};
const formatTime=iso=>iso?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(iso)):'—';
function fresh(){const age=Date.now()+serverOffset-Date.parse(latest?.captured_at);return networkOK&&age>=-30000&&age<=150000;}
function good(){return fresh()&&latest?.status==='ok'&&Number.isFinite(latest.value_c);}
function retainedNormal(record){const now=Date.now()+serverOffset;const oldest=new Date(now-29*86400000+9*3600000).toISOString().slice(0,10);return record?.status==='ok'&&Number.isFinite(record.value_c)&&Math.abs(record.value_c)<=9999.9&&Number.isFinite(Date.parse(record.captured_at))&&Date.parse(record.captured_at)<=now+30000&&new Date(Date.parse(record.captured_at)+9*3600000).toISOString().slice(0,10)>=oldest;}
function rememberNormal(record){if(!retainedNormal(record))return;if(!retainedNormal(lastNormal)||Date.parse(record.captured_at)>=Date.parse(lastNormal.captured_at)){lastNormal=record;try{localStorage.setItem('tc06-last-good-v1',JSON.stringify(record));}catch{}}}
function readingView(){if(!lookupDone)return{kind:'loading',record:null,value:null};if(good())return{kind:'good',record:latest,value:latest.value_c};
  const now=Date.now()+serverOffset,base=Date.parse(lastNormal?.captured_at),prediction=serverEstimate;
  if(networkOK&&retainedNormal(lastNormal)&&prediction?.estimated===true&&prediction.last_normal_id===lastNormal.id&&Date.parse(prediction.based_on_at)===base&&Number.isFinite(prediction.value_c)&&Math.abs(prediction.value_c)<=9999.9&&now>=base&&now-base<=120000&&Date.parse(prediction.expires_at)>=now&&Date.parse(prediction.expires_at)<=base+120000&&Date.parse(prediction.estimated_at)<=now+30000&&Date.parse(latest?.captured_at)>base)return{kind:'estimated',record:lastNormal,value:prediction.value_c};if(retainedNormal(lastNormal))return{kind:'held',record:lastNormal,value:lastNormal.value_c};if(lastNormal){lastNormal=null;try{localStorage.removeItem('tc06-last-good-v1');}catch{}}return{kind:'fallback',record:null,value:38};}
function ago(record){const seconds=Math.max(0,Math.floor((Date.now()+serverOffset-Date.parse(record.captured_at))/1000));const minutes=Math.floor(seconds/60);if(minutes<1)return`${seconds}초 전`;if(minutes<60)return`${minutes}분 전`;if(minutes<1440)return`${Math.floor(minutes/60)}시간 ${minutes%60}분 전`;return`${Math.floor(minutes/1440)}일 ${Math.floor(minutes%1440/60)}시간 전`;}
function fitNumber(){if(document.body.dataset.mode!=='display')return;const el=byId('temperature');el.style.fontSize='100px';const held=document.body.dataset.state!=='good';const factor=Math.min(innerWidth*.92/Math.max(el.getBoundingClientRect().width,1),innerHeight*(held ? .68 : .84)/100)*settings.size/100;el.style.fontSize=`${Math.floor(100*factor)}px`;}
function render(){
  const view=readingView(),valid=view.kind==='good',held=view.kind==='held',estimated=view.kind==='estimated',loading=view.kind==='loading',uncertain=held||estimated,changed=lastKind!==view.kind;
  document.body.dataset.state=view.kind;
  const text=loading?'—':view.kind==='fallback'?'38':(estimated?'≈':'')+Number(view.value).toFixed(1);
  if(byId('temperature').textContent!==text||changed){byId('temperature').textContent=text;fitNumber();}
  const age=estimated?'추정값 · 마지막 실측 '+ago(view.record):held?'마지막 정상값 · '+ago(view.record):'';
  const kind=loading?'불러오는 중':valid?'실측값':uncertain?age:'기본 표시값 · 실측 아님';
  const reason=loading?'온도를 불러오는 중입니다.':!networkOK?'서버 연결을 확인할 수 없습니다.':!latest?'아직 수신한 온도가 없습니다.':latest.status!=='ok'?(labels[latest.status]||'판독 상태를 확인해 주세요.'):!fresh()?'최근 150초 이내 실측값이 없습니다.':'최근 저장된 실측값입니다.';
  const connection=loading?'서버 확인 중':networkOK?'서버 연결됨':'서버 연결 확인 필요';
  byId('quality').textContent=kind;
  byId('reading-age').textContent=view.record?'마지막 실측 '+ago(view.record):loading?'마지막 실측 확인 중':'수신 이력 없음';
  const description=loading?reason:valid?'최근 저장된 실측값입니다.':estimated?reason+' 최근 실측 '+serverEstimate.sample_count+'개의 추세로 약 '+Number(view.value).toFixed(1)+'도를 추정합니다. 마지막 실측 후 최대 2분까지만 표시합니다.':held?reason+' 과거 실측값을 유지하고 있습니다.':reason+' 수신 이력이 없어 기본 표시값 38도를 사용합니다. 실측 온도가 아닙니다.';
  byId('status').textContent=description;
  byId('captured').textContent=formatTime(view.record?.captured_at);byId('received').textContent=formatTime(view.record?.received_at);
  byId('connection').textContent=connection;
  byId('countdown').textContent=enabled?(uncertain||loading?'수신 대기':Math.max(0,Math.ceil((nextAnnouncement-Date.now())/1000))+'초'):'꺼짐';
  byId('graph-temperature').textContent=text;byId('graph-quality').textContent=kind;
  byId('graph-current-status').textContent=connection+' · '+(view.record?'마지막 실측 '+ago(view.record)+' · 판독 '+formatTime(view.record.captured_at):loading?'첫 조회 대기':'수신 이력 없음')+(!valid&&!loading?' · '+reason:'');
  byId('graph-speech').textContent=enabled?'음성 중지':'음성 시작';
  byId('graph-reading-label').textContent=loading?'TC-06 · 온도 확인 중':estimated?'TC-06 · 추정 온도':held?'TC-06 · 마지막 정상 온도':valid?'TC-06 · 최신 실측 온도':'TC-06 · 기본 표시값';
  byId('display-state').textContent=valid?'실측값 · 마지막 실측 '+ago(view.record):kind;
  byId('display-held').hidden=valid;byId('display-held').textContent=uncertain?age:loading?'온도를 불러오는 중입니다':'수신 이력 없음 · 기본 표시값 38도';
  if((uncertain||loading)&&enabled){if(changed||voice.playing)voice.cancel();byId('audio-status').textContent=(loading?'온도 확인 중':age)+' · 음성 안내 대기';}
  else if(changed&&['held','estimated','loading'].includes(lastKind)&&enabled){byId('audio-status').textContent=valid?'최신 실측값 수신 · 다음 주기부터 음성 안내를 재개합니다.':'수신 이력 없음 · 기본 표시값임을 먼저 안내합니다.';}
  byId('speech-start').disabled=enabled;byId('speech-stop').disabled=!enabled;byId('display-speech').textContent=enabled?'음성 중지':'음성 시작';
  updateHistoryBounds();
  lastKind=view.kind;
}
function refresh(){
  if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
    try{const response=await fetch('/api/latest',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('server');const data=await response.json();if(!Number.isFinite(Date.parse(data.server_now)))throw Error('time');latest=data.record;serverEstimate=data.estimate||null;serverOffset=Date.parse(data.server_now)-Date.now();rememberNormal(data.last_good);rememberNormal(latest);networkOK=true;byId('updated').textContent=`조회 ${formatTime(data.server_now)}`;}
    catch{networkOK=false;}finally{clearTimeout(timeout);lookupDone=true;render();}
  })().finally(()=>{refreshPromise=null;});return refreshPromise;
}
async function manualRefresh(){
  const buttons=['refresh-latest','display-refresh'].map(byId),labels=buttons.map(button=>button.textContent);
  for(const button of buttons){button.disabled=true;button.textContent='재조회 중…';}
  for(const id of ['refresh-status','display-refresh-status']){byId(id).textContent='최신 온도를 다시 조회하고 있습니다…';byId(id).dataset.state='loading';}
  try{await refresh();for(const id of ['refresh-status','display-refresh-status']){byId(id).textContent=networkOK?'재조회 완료 · 자동 조회는 1분마다 계속됩니다.':'재조회 실패 · 인터넷 연결을 확인해 주세요. 자동 조회는 1분마다 다시 시도합니다.';byId(id).dataset.state=networkOK?'success':'error';}}
  finally{buttons.forEach((button,index)=>{button.disabled=false;button.textContent=labels[index];});}
}
async function announce(){
  if(!enabled||announcing||document.hidden)return;announcing=true;
  try{
    await refresh();if(!enabled)return;
    const view=readingView();if(['held','estimated','loading'].includes(view.kind)){byId('audio-status').textContent=`${view.kind==='estimated'?'추정값 · 마지막 실측':'마지막 정상값'} · ${ago(view.record)} 표시 중 · 음성 안내 대기`;return;}
    const valid=view.kind==='good',value=view.value;
    const played=await voice.say(value,settings.volume,view.kind);
    if(played&&enabled)byId('audio-status').textContent=`${valid?'실제 수신 온도':'기본 표시값 38도'} · 웹 숫자 TTS · ${settings.interval/60}분마다 한국어 여성 음성 안내`;
  }catch(error){byId('audio-status').textContent=error.message||'음성 시작을 다시 눌러 주세요.';}
  finally{announcing=false;}
}
async function start(){
  if(enabled)return;enabled=true;nextAnnouncement=Date.now()+settings.interval*1000;render();
  byId('audio-status').textContent='웹 숫자 TTS를 준비하고 있습니다.';
  try{await voice.unlock(settings.volume);if(enabled)await announce();}
  catch(error){enabled=false;voice.cancel();byId('audio-status').textContent=error.message||'음성 시작을 다시 눌러 주세요.';render();}
}
function stop(){enabled=false;voice.cancel();byId('audio-status').textContent='음성 안내가 꺼져 있습니다.';render();}
async function fullscreen(mode='display'){if(typeof mode!=='string')mode='display';setMode(mode);try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();}catch{byId('audio-status').textContent='브라우저 메뉴에서 전체 화면을 선택해 주세요.';}}
function setMode(mode,save=true){document.activeElement?.blur();document.body.dataset.mode=mode;byId('graph-screen').hidden=mode!=='graph';if(mode==='normal')byId('temperature').style.fontSize='';byId('display-menu').hidden=true;clearTimeout(menuTimer);if(save){const url=new URL(location.href);url.searchParams.set('mode',mode);history.replaceState(null,'',url);}fitNumber();if(mode==='graph'){graph?.draw();graph?.load();}}
function revealMenu(focusFirst=false){
  if(document.body.dataset.mode!=='display')return;
  const menu=byId('display-menu');menu.hidden=false;clearTimeout(menuTimer);
  if(focusFirst&&!menu.contains(document.activeElement))menu.querySelector('button:not(:disabled)')?.focus();
  menuTimer=setTimeout(()=>{if(!menu.contains(document.activeElement))menu.hidden=true;},5000);
}
function applySettings(){for(const key of ['volume','interval','color','size'])byId(key).value=settings[key];byId('custom-color').value=settings.customColor;byId('custom-color').hidden=settings.color!=='custom';voice.setVolume(settings.volume);const palette=settings.color==='custom'?{fg:settings.customColor,bg:'#000000'}:PALETTES[settings.color];document.documentElement.style.setProperty('--display-color',palette.fg);document.documentElement.style.setProperty('--display-bg',palette.bg);fitNumber();}
function openSettings(){setMode('normal');byId('settings-panel').open=true;byId('settings-panel').scrollIntoView({block:'start'});byId('volume').focus();}
for(const id of ['settings-open','graph-settings','display-settings'])byId(id).addEventListener('click',openSettings);
byId('settings-panel').addEventListener('toggle',()=>byId('settings-open').setAttribute('aria-expanded',String(byId('settings-panel').open)));
for(const key of ['volume','interval','color','size'])byId(key).addEventListener('input',()=>{settings[key]=key==='color'?byId(key).value:Number(byId(key).value);try{localStorage.setItem('tc06-settings-v2',JSON.stringify(settings));}catch{}if(key==='interval')nextAnnouncement=Date.now()+settings.interval*1000;applySettings();});
byId('custom-color').addEventListener('input',()=>{settings.customColor=byId('custom-color').value;settings.color='custom';try{localStorage.setItem('tc06-settings-v2',JSON.stringify(settings));}catch{}applySettings();});
for(const id of ['refresh-latest','display-refresh'])byId(id).addEventListener('click',manualRefresh);
byId('speech-start').addEventListener('click',start);byId('speech-stop').addEventListener('click',stop);byId('display-speech').addEventListener('click',()=>enabled?stop():start());
byId('fullscreen').addEventListener('click',fullscreen);byId('display-fullscreen').addEventListener('click',fullscreen);
byId('display-mode').addEventListener('click',()=>{setMode('display');fullscreen();});byId('normal-mode').addEventListener('click',()=>setMode('normal'));
byId('graph-mode').addEventListener('click',()=>setMode('graph'));byId('display-to-graph').addEventListener('click',()=>setMode('graph'));byId('graph-to-display').addEventListener('click',()=>setMode('display'));byId('graph-to-normal').addEventListener('click',()=>setMode('normal'));byId('graph-fullscreen').addEventListener('click',()=>fullscreen('graph'));byId('graph-speech').addEventListener('click',()=>enabled?stop():start());
byId('display-menu').addEventListener('focusout',event=>{if(!byId('display-menu').contains(event.relatedTarget))revealMenu();});
document.addEventListener('pointerdown',()=>revealMenu());document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){setMode('normal');return;}
  if(document.body.dataset.mode!=='display')return;
  const menu=byId('display-menu');
  if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();
    const buttons=Array.from(menu.querySelectorAll('button:not(:disabled)')),index=buttons.indexOf(document.activeElement);
    revealMenu(true);if(!buttons.length)return;
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:index<0?0:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+buttons.length)%buttons.length;
    buttons[next].focus();
  }else if(event.key==='Enter'){
    if(menu.hidden||!menu.contains(document.activeElement)){event.preventDefault();revealMenu(true);}else revealMenu();
  }else if(event.key==='Tab')revealMenu();
});window.addEventListener('resize',fitNumber);document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&['display','graph'].includes(document.body.dataset.mode))setMode('normal');});
function updateHistoryBounds(){
  const now=Date.now()+serverOffset,input=byId('history-day');
  input.min=new Date(now-29*86400000+9*3600000).toISOString().slice(0,10);
  input.max=new Date(now+9*3600000).toISOString().slice(0,10);
  if(!historyDateSelected)input.value=input.max;
}
let historyPending=false,historyDateSelected=false;
function historyMessage(message,state='ready'){byId('history-status').textContent=message;byId('history-status').dataset.state=state;}
async function downloadHistory(){
  if(historyPending)return;
  updateHistoryBounds();
  const input=byId('history-day'),date=input.value;
  if(!date||!input.checkValidity()){
    historyMessage(`기록 일자를 ${input.min}부터 ${input.max} 사이에서 선택해 주세요.`,'error');input.focus();return;
  }
  historyPending=true;byId('download').disabled=true;byId('download').textContent='다운로드 준비 중…';
  historyMessage(`${date} 기록을 불러오는 중입니다…`,'loading');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  try{
    const response=await fetch('/api/history?day='+encodeURIComponent(date),{cache:'no-store',signal:controller.signal});
    if(!response.ok){
      let message='기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
      try{const body=await response.json();if(typeof body.error==='string')message=body.error;}catch{}
      throw Error(message);
    }
    if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('text/csv'))throw Error('CSV 응답을 확인할 수 없습니다. 다시 시도해 주세요.');
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`TC06-${date}-KST.csv`;document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    historyMessage(`${date} 기록 다운로드를 시작했습니다.`,'success');
  }catch(error){
    historyMessage(error.name==='AbortError'?'기록 조회 시간이 초과됐습니다. 다시 시도해 주세요.':error instanceof TypeError?'인터넷 연결을 확인하고 CSV 다운로드를 다시 눌러 주세요.':error.message,'error');
  }finally{clearTimeout(timeout);historyPending=false;byId('download').disabled=false;byId('download').textContent='CSV 다운로드';}
}
updateHistoryBounds();
byId('history-day').addEventListener('input',()=>{historyDateSelected=true;if(!historyPending)historyMessage('한국시간 기준 오늘을 포함한 최근 30일의 기록을 받을 수 있습니다.');});
byId('download').addEventListener('click',downloadHistory);
document.addEventListener('visibilitychange',()=>{if(document.hidden){voice.cancel();}else{refresh();graph?.load();}});window.addEventListener('offline',()=>{networkOK=false;lookupDone=true;render();});window.addEventListener('online',()=>{refresh();graph?.load(true);});
setInterval(()=>{if(!document.hidden){refresh();graph?.load();}},60000);setInterval(()=>{render();if(enabled&&Date.now()>=nextAnnouncement){nextAnnouncement=Date.now()+settings.interval*1000;announce();}},1000);
graph=new TC06Graph.Graph(()=>Date.now()+serverOffset);
const initialMode=new URLSearchParams(location.search).get('mode');setMode(['normal','graph'].includes(initialMode)?initialMode:'display',false);applySettings();render();refresh();voice.preload().catch(()=>{});
fetch('/api/retention',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(data=>{if(data?.last_cleanup)byId('retention-status').textContent=`최근 30일 보관 (한국날짜 기준) · 매시 15분 자동 삭제 · 최근 정리 ${formatTime(data.last_cleanup.ran_at)}`;}).catch(()=>{});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
