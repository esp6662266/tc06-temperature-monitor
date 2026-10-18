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
let latest=null,serverOffset=0,networkOK=false,enabled=false,nextAnnouncement=0,announcing=false,refreshPromise=null;
let menuTimer=null,graph=null;
let lastNormal=null,lastKind=null,serverEstimate=null;
try{lastNormal=JSON.parse(localStorage.getItem('tc06-last-good-v1')||'null');}catch{}
const labels={ocr_timeout:'판독 시간이 초과되어 다시 읽는 중입니다',anchor_missing:'TC-06을 찾을 수 없습니다',ambiguous_anchor:'TC-06 표시가 여러 개입니다',occluded:'온도 영역이 다른 창에 가려졌습니다',ocr_failed:'온도를 판독할 수 없습니다',value_suspect:'숫자 재확인이 필요합니다',low_confidence:'숫자가 선명하지 않습니다',freshness_unverified:'원본 시계의 진행을 확인 중입니다',stale_source:'원본 영상 정지가 의심됩니다',source_error:'영상 입력을 확인해 주세요',window_missing:'HMI 창을 확인해 주세요'};
const formatTime=iso=>iso?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(iso)):'—';
function fresh(){const age=Date.now()+serverOffset-Date.parse(latest?.captured_at);return networkOK&&age>=-30000&&age<=150000;}
function good(){return fresh()&&latest?.status==='ok'&&Number.isFinite(latest.value_c);}
function retainedNormal(record){const now=Date.now()+serverOffset;const oldest=new Date(now-29*86400000+9*3600000).toISOString().slice(0,10);return record?.status==='ok'&&Number.isFinite(record.value_c)&&Math.abs(record.value_c)<=9999.9&&Number.isFinite(Date.parse(record.captured_at))&&Date.parse(record.captured_at)<=now+30000&&new Date(Date.parse(record.captured_at)+9*3600000).toISOString().slice(0,10)>=oldest;}
function rememberNormal(record){if(!retainedNormal(record))return;if(!retainedNormal(lastNormal)||Date.parse(record.captured_at)>=Date.parse(lastNormal.captured_at)){lastNormal=record;try{localStorage.setItem('tc06-last-good-v1',JSON.stringify(record));}catch{}}}
function readingView(){if(good())return{kind:'good',record:latest,value:latest.value_c};
  const now=Date.now()+serverOffset,base=Date.parse(lastNormal?.captured_at),prediction=serverEstimate;
  if(networkOK&&retainedNormal(lastNormal)&&prediction?.estimated===true&&prediction.last_normal_id===lastNormal.id&&Date.parse(prediction.based_on_at)===base&&Number.isFinite(prediction.value_c)&&Math.abs(prediction.value_c)<=9999.9&&now>=base&&now-base<=120000&&Date.parse(prediction.expires_at)>=now&&Date.parse(prediction.expires_at)<=base+120000&&Date.parse(prediction.estimated_at)<=now+30000&&Date.parse(latest?.captured_at)>base)return{kind:'estimated',record:lastNormal,value:prediction.value_c};if(retainedNormal(lastNormal))return{kind:'held',record:lastNormal,value:lastNormal.value_c};if(lastNormal){lastNormal=null;try{localStorage.removeItem('tc06-last-good-v1');}catch{}}return{kind:'fallback',record:null,value:38};}
function ago(record){const minutes=Math.max(0,Math.floor((Date.now()+serverOffset-Date.parse(record.captured_at))/60000));if(minutes<1)return'1분 미만 전';if(minutes<60)return`${minutes}분 전`;if(minutes<1440)return`${Math.floor(minutes/60)}시간 ${minutes%60}분 전`;return`${Math.floor(minutes/1440)}일 ${Math.floor(minutes%1440/60)}시간 전`;}
function fitNumber(){if(document.body.dataset.mode!=='display')return;const el=byId('temperature');el.style.fontSize='100px';const held=['held','estimated'].includes(document.body.dataset.state);const factor=Math.min(innerWidth*.92/Math.max(el.getBoundingClientRect().width,1),innerHeight*(held ? .68 : .84)/100)*settings.size/100;el.style.fontSize=`${Math.floor(100*factor)}px`;}
function render(){
  const view=readingView(),valid=view.kind==='good',held=view.kind==='held',estimated=view.kind==='estimated',uncertain=held||estimated,changed=lastKind!==view.kind;
  document.body.dataset.state=view.kind;
  const text=view.kind==='fallback'?'38':(estimated?'≈':'')+Number(view.value).toFixed(1);
  if(byId('temperature').textContent!==text||changed){byId('temperature').textContent=text;fitNumber();}
  const age=estimated?'추정값 · 마지막 실측 '+ago(view.record):held?'마지막 정상값 · '+ago(view.record):'';
  byId('quality').textContent=valid?'실제 수신값':uncertain?age:'기본값 · 38도';
  const reason=!networkOK?'서버 연결을 확인할 수 없습니다.':!latest?'아직 수신한 온도가 없습니다.':!fresh()?'최근 150초 이내 온도가 없습니다.':labels[latest.status]||'온도 정보를 확인해 주세요.';
  byId('status').textContent=valid?'최근 저장된 온도입니다.':estimated?reason+' 최근 정상값 '+serverEstimate.sample_count+'개의 추세로 약 '+Number(view.value).toFixed(1)+'도를 추정합니다. 마지막 실측 후 최대 2분까지만 표시합니다.':held?reason+' '+age+' 온도를 유지하고 있습니다.':reason+' 정상 수신 이력이 없어 기본값 38도를 표시·안내합니다.';
  byId('captured').textContent=formatTime(view.record?.captured_at);byId('received').textContent=formatTime(view.record?.received_at);
  byId('connection').textContent=networkOK?'서버 연결됨':'서버 연결 확인 필요';
  byId('countdown').textContent=enabled?Math.max(0,Math.ceil((nextAnnouncement-Date.now())/1000))+'초':'꺼짐';
  byId('graph-temperature').textContent=text;byId('graph-quality').textContent=byId('quality').textContent;
  byId('graph-current-status').textContent=valid?'판독 '+formatTime(latest.captured_at)+' · 서버 연결됨':uncertain?age+' · 실측 '+formatTime(view.record.captured_at)+' · '+reason:reason+' 기본값 38도 표시';
  byId('graph-speech').textContent=enabled?'음성 중지':'음성 시작';
  byId('graph-reading-label').textContent=estimated?'TC-06 · 추정 온도':held?'TC-06 · 마지막 정상 온도':'TC-06 · 현재 온도';
  byId('display-held').hidden=!uncertain;if(byId('display-held').textContent!==age)byId('display-held').textContent=age;
  if(uncertain&&enabled){if(changed||voice.playing)voice.cancel();byId('audio-status').textContent=age+' 표시 중 · 최신 온도로 오인하지 않도록 음성 안내 대기';}
  else if(changed&&['held','estimated'].includes(lastKind)&&enabled){byId('audio-status').textContent='최신 정상 온도 수신 · 다음 주기부터 음성 안내를 재개합니다.';}
  byId('speech-start').disabled=enabled;byId('speech-stop').disabled=!enabled;byId('display-speech').textContent=enabled?'음성 중지':'음성 시작';
  lastKind=view.kind;
}
function refresh(){
  if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
    try{const response=await fetch('/api/latest',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('server');const data=await response.json();if(!Number.isFinite(Date.parse(data.server_now)))throw Error('time');latest=data.record;serverEstimate=data.estimate||null;serverOffset=Date.parse(data.server_now)-Date.now();rememberNormal(data.last_good);rememberNormal(latest);networkOK=true;byId('updated').textContent=`조회 ${formatTime(data.server_now)}`;}
    catch{networkOK=false;}finally{clearTimeout(timeout);render();}
  })().finally(()=>{refreshPromise=null;});return refreshPromise;
}
async function announce(){
  if(!enabled||announcing||document.hidden)return;announcing=true;
  try{
    await refresh();if(!enabled)return;
    const view=readingView();if(['held','estimated'].includes(view.kind)){byId('audio-status').textContent=`${view.kind==='estimated'?'추정값 · 마지막 실측':'마지막 정상값'} · ${ago(view.record)} 표시 중 · 음성 안내 대기`;return;}
    const valid=view.kind==='good',value=view.value;
    const played=await voice.say(value,settings.volume);
    if(played&&enabled)byId('audio-status').textContent=`${valid?'실제 수신 온도':'기본값 38도'} · 웹 숫자 TTS · ${settings.interval/60}분마다 한국어 여성 음성 안내`;
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
function revealMenu(){if(document.body.dataset.mode!=='display')return;byId('display-menu').hidden=false;clearTimeout(menuTimer);menuTimer=setTimeout(()=>{byId('display-menu').hidden=true;},5000);}
function applySettings(){for(const key of ['volume','interval','color','size'])byId(key).value=settings[key];byId('custom-color').value=settings.customColor;voice.setVolume(settings.volume);const palette=settings.color==='custom'?{fg:settings.customColor,bg:'#000000'}:PALETTES[settings.color];document.documentElement.style.setProperty('--display-color',palette.fg);document.documentElement.style.setProperty('--display-bg',palette.bg);for(const button of byId('palettes').children)button.setAttribute('aria-pressed',String(button.dataset.palette===settings.color));fitNumber();}
for(const [key,palette] of Object.entries(PALETTES)){const button=document.createElement('button');button.type='button';button.dataset.palette=key;button.className='palette';button.style.backgroundColor=palette.bg;button.style.color=palette.fg;const number=document.createElement('span');number.className='palette-number';number.textContent='38';const label=document.createElement('span');label.textContent=palette.label;button.append(number,label);button.addEventListener('click',()=>{settings.color=key;try{localStorage.setItem('tc06-settings-v2',JSON.stringify(settings));}catch{}applySettings();});byId('palettes').append(button);}
for(const key of ['volume','interval','color','size'])byId(key).addEventListener('input',()=>{settings[key]=key==='color'?byId(key).value:Number(byId(key).value);try{localStorage.setItem('tc06-settings-v2',JSON.stringify(settings));}catch{}if(key==='interval')nextAnnouncement=Date.now()+settings.interval*1000;applySettings();});
byId('custom-color').addEventListener('input',()=>{settings.customColor=byId('custom-color').value;settings.color='custom';try{localStorage.setItem('tc06-settings-v2',JSON.stringify(settings));}catch{}applySettings();});
byId('speech-start').addEventListener('click',start);byId('speech-stop').addEventListener('click',stop);byId('display-speech').addEventListener('click',()=>enabled?stop():start());
byId('fullscreen').addEventListener('click',fullscreen);byId('display-fullscreen').addEventListener('click',fullscreen);
byId('display-mode').addEventListener('click',()=>{setMode('display');fullscreen();});byId('normal-mode').addEventListener('click',()=>setMode('normal'));
byId('graph-mode').addEventListener('click',()=>setMode('graph'));byId('display-to-graph').addEventListener('click',()=>setMode('graph'));byId('graph-to-display').addEventListener('click',()=>setMode('display'));byId('graph-to-normal').addEventListener('click',()=>setMode('normal'));byId('graph-fullscreen').addEventListener('click',()=>fullscreen('graph'));byId('graph-speech').addEventListener('click',()=>enabled?stop():start());
document.addEventListener('pointerdown',revealMenu);document.addEventListener('keydown',event=>{if(event.key==='Escape')setMode('normal');else if(['Enter','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'].includes(event.key))revealMenu();});window.addEventListener('resize',fitNumber);document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&['display','graph'].includes(document.body.dataset.mode))setMode('normal');});
byId('history-day').value=new Date(Date.now()+9*3600000).toISOString().slice(0,10);byId('download').addEventListener('click',()=>{location.href='/api/history?day='+encodeURIComponent(byId('history-day').value);});
document.addEventListener('visibilitychange',()=>{if(document.hidden){voice.cancel();}else{refresh();graph?.load();}});window.addEventListener('offline',()=>{networkOK=false;render();});window.addEventListener('online',()=>{refresh();graph?.load(true);});
setInterval(()=>{if(!document.hidden){refresh();graph?.load();}},60000);setInterval(()=>{render();if(enabled&&Date.now()>=nextAnnouncement){nextAnnouncement=Date.now()+settings.interval*1000;announce();}},1000);
graph=new TC06Graph.Graph(()=>Date.now()+serverOffset);
const initialMode=new URLSearchParams(location.search).get('mode');setMode(['normal','graph'].includes(initialMode)?initialMode:'display',false);applySettings();render();refresh();voice.preload().catch(()=>{});
fetch('/api/retention',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(data=>{if(data?.last_cleanup)byId('retention-status').textContent=`최근 30일 보관 (한국날짜 기준) · 매시 15분 자동 삭제 · 최근 정리 ${formatTime(data.last_cleanup.ran_at)}`;}).catch(()=>{});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
