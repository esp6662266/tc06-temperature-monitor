/* Shared site setting. Real collector records are the only application evidence. */
window.TC06Collection=(()=>{
  const el=id=>document.getElementById(id);
  const valid=n=>Number.isSafeInteger(n)&&n>=30&&n<=3600;
  const label=n=>n%60===0?`${n/60}분`:`${n}초`;
  let current=null,busy=false,dirty=false,draftRevision=null,applied=null,recordAt=null;
  function preview(){
    const n=Number(el('collection-seconds').value);
    el('collection-volume').textContent=valid(n)?`하루 약 ${Math.ceil(86400/n).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}건 기록 · 이 화면도 ${label(n)}마다 조회`:'30~3600초 사이의 정수를 입력하세요.';
  }
  function status(){
    el('collection-current').textContent=current?`서버 설정: ${label(current.interval_seconds)}`:'서버 설정 확인 중';
    el('collection-applied').textContent=applied?`PC의 마지막 기록: ${label(applied)} 간격 적용 · ${new Date(recordAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}`:'PC 적용 미확인 · 0.7.0 이상 수집기의 새 기록이 필요합니다.';
    el('recording-policy').textContent=current?`${label(current.interval_seconds)} 간격 기록·조회 설정 · 한국시간 표시`:'기록 간격 확인 중 · 한국시간 표시';
    if(current&&!el('refresh-status').dataset.state)el('refresh-status').textContent=`온도는 ${label(current.interval_seconds)}마다 자동 조회합니다.`;
    el('collection-save').disabled=busy||!current;
  }
  function accept(value){
    if(!value||!valid(value.interval_seconds)||!Number.isSafeInteger(value.revision)||value.revision<0)return;
    if(current&&value.revision<current.revision)return;
    // Preserve the revision associated with a user's unfinished edit.
    current=value;
    if(!dirty){draftRevision=value.revision;el('collection-seconds').value=value.interval_seconds;preview();}
    status();
  }
  function observe(data){
    accept(data.collection_settings);
    const record=data.record;
    if(record&&Number.isFinite(Date.parse(record.captured_at))&&(!recordAt||Date.parse(record.captured_at)>=Date.parse(recordAt))){
      applied=valid(record.record_interval_seconds)?record.record_interval_seconds:null;recordAt=record.captured_at;
    }
    status();
  }
  async function request(method='GET',body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch('/api/settings',{method,cache:'no-store',signal:controller.signal,
        ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
      const data=await response.json();if(!response.ok)throw Error(data.error||'서버 설정을 확인할 수 없습니다.');return data;
    }finally{clearTimeout(timer);}
  }
  function setBusy(value){busy=value;el('collection-save').disabled=value||!current;el('collection-reload').disabled=value;}
  function edit(){if(!dirty)draftRevision=current?.revision;dirty=true;preview();}
  el('collection-seconds').addEventListener('input',edit);
  for(const button of document.querySelectorAll('[data-collection-seconds]'))button.addEventListener('click',()=>{el('collection-seconds').value=button.dataset.collectionSeconds;edit();});
  el('collection-reload').addEventListener('click',async()=>{
    if(busy)return;setBusy(true);
    try{const data=await request();dirty=false;accept(data);el('collection-result').textContent='서버 설정을 다시 불러왔습니다.';}
    catch{el('collection-result').textContent='설정을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.';}
    finally{setBusy(false);}
  });
  el('collection-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!current)return;
    const seconds=Number(el('collection-seconds').value);
    if(!valid(seconds)){el('collection-result').textContent='30~3600초 사이의 정수를 입력하세요.';return;}
    setBusy(true);el('collection-result').textContent='서버에 설정 저장 중…';
    try{
      const data=await request('POST',{interval_seconds:seconds,revision:draftRevision});
      dirty=false;accept(data);
      el('collection-result').textContent=`${label(seconds)} 간격을 서버에 저장했습니다. PC 반영 대기 · 지원 수집기는 최대 약 6분 안에 설정을 받으며, 다음 기록에서 적용을 확인할 수 있습니다.`;
    }catch(error){el('collection-result').textContent=(error.name==='AbortError'?'응답이 늦어 저장 여부가 불확실합니다. 설정 다시 불러오기로 먼저 확인하세요.':error.message||'설정 저장 실패')+' 입력한 값은 유지됩니다.';}
    finally{setBusy(false);}
  });
  status();preview();
  return {observe,get seconds(){return current?.interval_seconds||60;},get label(){return label(this.seconds);}};
})();
