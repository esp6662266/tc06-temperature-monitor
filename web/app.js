'use strict';
const byId = id => document.getElementById(id);
const player = byId('audio');
const FALLBACK_AUDIO = '/audio/fallback-38.mp3';
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
let fallbackURL=null,menuTimer=null;
const labels={anchor_missing:'TC-06을 찾을 수 없습니다',ambiguous_anchor:'TC-06 표시가 여러 개입니다',occluded:'온도 영역이 다른 창에 가려졌습니다',ocr_failed:'온도를 판독할 수 없습니다',value_suspect:'숫자 재확인이 필요합니다',low_confidence:'숫자가 선명하지 않습니다',freshness_unverified:'원본 시계의 진행을 확인 중입니다',stale_source:'원본 영상 정지가 의심됩니다',source_error:'영상 입력을 확인해 주세요',window_missing:'HMI 창을 확인해 주세요'};
const formatTime=iso=>iso?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(iso)):'—';
function fresh(){const age=Date.now()+serverOffset-Date.parse(latest?.captured_at);return networkOK&&age>=-30000&&age<=150000;}
function good(){return fresh()&&latest?.status==='ok'&&Number.isFinite(latest.value_c);}
function fitNumber(){if(document.body.dataset.mode!=='display')return;const el=byId('temperature');el.style.fontSize='100px';const factor=Math.min(innerWidth*.92/Math.max(el.getBoundingClientRect().width,1),innerHeight*.84/100)*settings.size/100;el.style.fontSize=`${Math.floor(100*factor)}px`;}
function render(){
  const valid=good();document.body.dataset.state=valid?'good':'fallback';
  const text=valid?Number(latest.value_c).toFixed(1):'38';
  if(byId('temperature').textContent!==text){byId('temperature').textContent=text;fitNumber();}
  byId('quality').textContent=valid?'실제 수신값':'기본값 · 38도';
  const reason=!networkOK?'서버 연결을 확인할 수 없습니다.':!latest?'아직 수신한 온도가 없습니다.':!fresh()?'최근 150초 이내 온도가 없습니다.':labels[latest.status]||'온도 정보를 확인해 주세요.';
  byId('status').textContent=valid?'최근 저장된 온도입니다.':`${reason} 기본값 38도를 표시·안내합니다.`;
  byId('captured').textContent=formatTime(latest?.captured_at);byId('received').textContent=formatTime(latest?.received_at);
  byId('connection').textContent=networkOK?'서버 연결됨':'서버 연결 확인 필요';
  byId('countdown').textContent=enabled?`${Math.max(0,Math.ceil((nextAnnouncement-Date.now())/1000))}초`:'꺼짐';
  byId('speech-start').disabled=enabled;byId('speech-stop').disabled=!enabled;byId('display-speech').textContent=enabled?'음성 중지':'음성 시작';
}
function refresh(){
  if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
    try{const response=await fetch('/api/latest',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('server');const data=await response.json();if(!Number.isFinite(Date.parse(data.server_now)))throw Error('time');latest=data.record;serverOffset=Date.parse(data.server_now)-Date.now();networkOK=true;byId('updated').textContent=`조회 ${formatTime(data.server_now)}`;}
    catch{networkOK=false;}finally{clearTimeout(timeout);render();}
  })().finally(()=>{refreshPromise=null;});return refreshPromise;
}
async function cacheFallback(){try{const response=await fetch(FALLBACK_AUDIO);if(response.ok)fallbackURL=URL.createObjectURL(await response.blob());}catch{/* Service worker or browser synthesis can supply the offline fallback. */}}
function browserSpeak(value){
  if(!('speechSynthesis' in window))return false;
  const voices=speechSynthesis.getVoices();const voice=voices.find(v=>/^ko[-_]KR/i.test(v.lang)&&/Yuna|유나|Heami|해미|SunHi|선히|female|여성/i.test(v.name));
  if(!voice)return false;
  const utterance=new SpeechSynthesisUtterance(`현재 온도는 ${value}도입니다.`);utterance.lang='ko-KR';utterance.voice=voice;utterance.volume=settings.volume;speechSynthesis.cancel();speechSynthesis.speak(utterance);return true;
}
async function announce(){
  if(!enabled||announcing||document.hidden)return;announcing=true;
  try{await refresh();if(!enabled)return;
    if(good()&&!latest.has_audio){if(browserSpeak(latest.value_c)){byId('audio-status').textContent='이 기기의 한국어 여성 음성으로 안내 중';return;}byId('audio-status').textContent='실제 온도의 음성 파일이 없습니다. PC의 한국어 여성 음성 생성을 확인하세요.';return;}
    player.src=good()?'/api/audio?id='+encodeURIComponent(latest.audio_id):fallbackURL||FALLBACK_AUDIO;player.volume=settings.volume;
    try{await player.play();}catch(error){if(!good()&&browserSpeak(38)){byId('audio-status').textContent='기본값 38도 · 이 기기의 한국어 여성 음성 안내';return;}throw error;}
    byId('audio-status').textContent=good()?`실제 수신 온도 · ${settings.interval/60}분마다 한국어 여성 음성 안내`:`기본값 38도 · ${settings.interval/60}분마다 한국어 여성 음성 안내`;
  }catch{byId('audio-status').textContent='음성 시작을 눌러 주세요. 브라우저 소리 재생 권한과 음성 파일을 확인하세요.';}finally{announcing=false;}
}
function silentWav(){const buffer=new ArrayBuffer(844),v=new DataView(buffer);const str=(at,text)=>[...text].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));str(0,'RIFF');v.setUint32(4,836,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,800,true);return URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));}
async function start(){if(enabled)return;const unlock=silentWav();try{player.src=unlock;player.volume=settings.volume;await player.play();enabled=true;nextAnnouncement=Date.now()+settings.interval*1000;render();await announce();}catch{byId('audio-status').textContent='음성 시작이 차단됐습니다. 브라우저의 소리 재생 설정을 확인하세요.';}finally{URL.revokeObjectURL(unlock);}}
function stop(){enabled=false;player.pause();if('speechSynthesis'in window)speechSynthesis.cancel();byId('audio-status').textContent='음성 안내가 꺼져 있습니다.';render();}
async function fullscreen(){setMode('display');try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();}catch{byId('audio-status').textContent='브라우저 메뉴에서 전체 화면을 선택해 주세요.';}}
function setMode(mode,save=true){document.body.dataset.mode=mode;if(mode==='normal')byId('temperature').style.fontSize='';byId('display-menu').hidden=true;clearTimeout(menuTimer);if(save){const url=new URL(location.href);url.searchParams.set('mode',mode);history.replaceState(null,'',url);}fitNumber();}
function revealMenu(){if(document.body.dataset.mode!=='display')return;byId('display-menu').hidden=false;clearTimeout(menuTimer);menuTimer=setTimeout(()=>{byId('display-menu').hidden=true;},5000);}
function applySettings(){for(const key of ['volume','interval','color','size'])byId(key).value=settings[key];byId('custom-color').value=settings.customColor;player.volume=settings.volume;const palette=settings.color==='custom'?{fg:settings.customColor,bg:'#000000'}:PALETTES[settings.color];document.documentElement.style.setProperty('--display-color',palette.fg);document.documentElement.style.setProperty('--display-bg',palette.bg);for(const button of byId('palettes').children)button.setAttribute('aria-pressed',String(button.dataset.palette===settings.color));fitNumber();}
for(const [key,palette] of Object.entries(PALETTES)){const button=document.createElement('button');button.type='button';button.dataset.palette=key;button.className='palette';button.style.backgroundColor=palette.bg;button.style.color=palette.fg;const number=document.createElement('span');number.className='palette-number';number.textContent='38';const label=document.createElement('span');label.textContent=palette.label;button.append(number,label);button.addEventListener('click',()=>{settings.color=key;try{localStorage.setItem('tc06-settings-v2',JSON.stringify(settings));}catch{}applySettings();});byId('palettes').append(button);}
for(const key of ['volume','interval','color','size'])byId(key).addEventListener('input',()=>{settings[key]=key==='color'?byId(key).value:Number(byId(key).value);try{localStorage.setItem('tc06-settings-v2',JSON.stringify(settings));}catch{}if(key==='interval')nextAnnouncement=Date.now()+settings.interval*1000;applySettings();});
byId('custom-color').addEventListener('input',()=>{settings.customColor=byId('custom-color').value;settings.color='custom';try{localStorage.setItem('tc06-settings-v2',JSON.stringify(settings));}catch{}applySettings();});
byId('speech-start').addEventListener('click',start);byId('speech-stop').addEventListener('click',stop);byId('display-speech').addEventListener('click',()=>enabled?stop():start());
byId('fullscreen').addEventListener('click',fullscreen);byId('display-fullscreen').addEventListener('click',fullscreen);
byId('display-mode').addEventListener('click',()=>{setMode('display');fullscreen();});byId('normal-mode').addEventListener('click',()=>setMode('normal'));
document.addEventListener('pointerdown',revealMenu);document.addEventListener('keydown',event=>{if(event.key==='Escape')setMode('normal');else if(['Enter','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'].includes(event.key))revealMenu();});window.addEventListener('resize',fitNumber);document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&document.body.dataset.mode==='display')setMode('normal');});
byId('history-day').value=new Date(Date.now()+9*3600000).toISOString().slice(0,10);byId('download').addEventListener('click',()=>{location.href='/api/history?day='+encodeURIComponent(byId('history-day').value);});
document.addEventListener('visibilitychange',()=>{if(document.hidden){player.pause();if('speechSynthesis'in window)speechSynthesis.cancel();}else refresh();});window.addEventListener('offline',()=>{networkOK=false;render();});window.addEventListener('online',refresh);
player.addEventListener('error',()=>{if(enabled)byId('audio-status').textContent='음성 파일 재생을 확인해 주세요.';});
setInterval(()=>{if(!document.hidden)refresh();},60000);setInterval(()=>{render();if(enabled&&Date.now()>=nextAnnouncement){nextAnnouncement=Date.now()+settings.interval*1000;announce();}},1000);
setMode(new URLSearchParams(location.search).get('mode')==='normal'?'normal':'display',false);applySettings();render();refresh();cacheFallback();
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
