'use strict';
const byId = id => document.getElementById(id);
const player = byId('audio');
let latest = null;
let serverOffset = 0;
let networkOK = false;
let enabled = false;
let nextAnnouncement = 0;
let announcing = false;
let timer = null;
let refreshing = false;
let noticeURL = null;
let noticeAttemptAt = 0;
const labels = { anchor_missing:'TC-06을 찾을 수 없습니다', ambiguous_anchor:'TC-06 표시가 여러 개입니다',
  occluded:'온도 영역이 다른 창에 가려졌습니다', ocr_failed:'온도를 판독할 수 없습니다',
  value_suspect:'숫자 재확인이 필요합니다', low_confidence:'숫자가 선명하지 않습니다',
  freshness_unverified:'원본 시계의 진행을 확인 중입니다', stale_source:'원본 영상 정지가 의심됩니다',
  source_error:'영상 입력을 확인해 주세요', window_missing:'HMI 창을 확인해 주세요' };
const formatTime = iso => iso ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}).format(new Date(iso)) : '—';
function fresh() {
  if (!latest || !networkOK) return false;
  const age = Date.now() + serverOffset - Date.parse(latest.captured_at);
  return age >= -30000 && age <= 150000;
}
async function cacheNotice() {
  if (noticeURL || Date.now()-noticeAttemptAt<60000) return;
  noticeAttemptAt=Date.now();
  try {
    const response=await fetch('/api/audio?id=notice-stale');
    if(response.ok) noticeURL=URL.createObjectURL(await response.blob());
  } catch { /* Keep the previous in-memory warning available during outages. */ }
}
function render() {
  const good = fresh() && latest.status === 'ok';
  document.body.dataset.state = good ? 'good' : 'bad';
  byId('temperature').textContent = good ? Number(latest.value_c).toFixed(1) : '—';
  byId('quality').textContent = good ? '판독 정상' : !latest ? '데이터 대기' : !fresh() ? '갱신 끊김' : '판독 확인 필요';
  byId('status').textContent = good ? '최근 저장된 온도입니다.' : !latest ? 'PC 수집기를 시작하고 첫 1분 저장을 기다려 주세요.' : !networkOK ? '서버 연결을 확인할 수 없습니다.' : !fresh() ? '최근 온도가 없습니다. 현장 화면을 확인해 주세요.' : labels[latest.status] || '온도 정보를 확인해 주세요.';
  byId('captured').textContent = formatTime(latest?.captured_at);
  byId('received').textContent = formatTime(latest?.received_at);
  byId('connection').textContent = networkOK ? '서버 연결됨' : '서버 연결 확인 필요';
  byId('countdown').textContent = enabled ? `${Math.max(0,Math.ceil((nextAnnouncement-Date.now())/1000))}초` : '꺼짐';
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),10000);
    let response;
    try { response = await fetch('/api/latest', {cache:'no-store', signal:controller.signal}); }
    finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error('server');
    const data = await response.json();
    latest = data.record;
    serverOffset = Date.parse(data.server_now) - Date.now();
    networkOK = true;
    if (latest) cacheNotice();
    byId('updated').textContent = `조회 ${formatTime(data.server_now)}`;
  } catch { networkOK = false; }
  finally { refreshing = false; render(); }
}
function stop() {
  enabled = false;
  announcing = false;
  clearInterval(timer);
  timer = null;
  player.pause();
  byId('speech-start').disabled = false;
  byId('speech-stop').disabled = true;
  byId('audio-status').textContent = '음성 안내가 꺼져 있습니다.';
  render();
}
async function announce() {
  if (!enabled || announcing || document.hidden) return;
  announcing = true;
  try {
    await refresh();
    if (!enabled) return;
    const record = latest;
    if (fresh() && record?.status === 'ok' && !record.has_audio) {
      player.pause();
      byId('audio-status').textContent = '온도는 수신됐지만 음성 파일이 없습니다. PC의 한국어 여성 음성 생성을 확인하세요.';
      return;
    }
    const id = fresh() && record?.has_audio ? record.audio_id : 'notice-stale';
    if (record && fresh() && !record.has_audio) byId('audio-status').textContent = 'PC의 한국어 여성 음성 생성 상태를 확인하세요.';
    player.src = id === 'notice-stale' && noticeURL ? noticeURL : '/api/audio?id=' + encodeURIComponent(id);
    player.volume = Number(byId('volume').value);
    await player.play();
    byId('audio-status').textContent = id === 'notice-stale' ? '갱신 끊김 안내 · 온도는 읽지 않습니다.' : '한국어 여성 음성 안내 중 · 1분마다 반복';
  } catch {
    byId('audio-status').textContent = '음성을 재생할 수 없습니다. 음성 파일·네트워크·TV 재생 권한을 확인하고 다시 시작하세요.';
  } finally { announcing = false; }
}
function silentWav() {
  // Unlock this audio element from the remote-control click, without external services.
  const buffer = new ArrayBuffer(844), view = new DataView(buffer);
  const str = (at,text) => [...text].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)));
  str(0,'RIFF'); view.setUint32(4,836,true); str(8,'WAVE'); str(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,8000,true); view.setUint32(28,16000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  str(36,'data'); view.setUint32(40,800,true);
  return URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));
}
byId('speech-start').addEventListener('click', async () => {
  if (enabled) return;
  const unlock = silentWav();
  try {
    player.src = unlock;
    player.volume = Number(byId('volume').value);
    await player.play();
    enabled = true;
    byId('speech-start').disabled = true;
    byId('speech-stop').disabled = false;
    nextAnnouncement = Date.now()+60000;
    timer = setInterval(() => {
      if (Date.now() >= nextAnnouncement) { nextAnnouncement=Date.now()+60000; announce(); }
      render();
    },1000);
    await announce();
  } catch { byId('audio-status').textContent = '이 TV에서 음성 시작이 차단됐습니다. 브라우저의 소리 재생 설정을 확인하세요.'; }
  finally { URL.revokeObjectURL(unlock); }
});
byId('speech-stop').addEventListener('click',stop);
byId('volume').addEventListener('input',()=>{player.volume=Number(byId('volume').value);});
byId('fullscreen').addEventListener('click',async()=>{try{await document.documentElement.requestFullscreen();}catch{byId('audio-status').textContent='전체 화면 기능은 TV 브라우저 설정에서 선택해 주세요.';}});
byId('history-day').value=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
byId('download').addEventListener('click',()=>{window.location.href='/api/history?day='+encodeURIComponent(byId('history-day').value);});
document.addEventListener('visibilitychange',()=>{if(document.hidden)player.pause();else refresh();});
player.addEventListener('error',()=>{if(enabled)byId('audio-status').textContent='음성 파일을 재생할 수 없습니다. PC 음성 생성과 TV의 WAV 재생을 확인하세요.';});
setInterval(()=>{if(!document.hidden)refresh();},60000);
setInterval(render,1000);
refresh();
