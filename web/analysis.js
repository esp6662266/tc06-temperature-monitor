'use strict';
(() => {
  const el = id => document.getElementById(id);
  const screen = el('analysis-screen');
  if (!screen) return;

  const minute = 60000;
  const hour = 60 * minute;
  const defaults = [
    {name:'점심', start:'11:20', end:'12:00'},
    {name:'참시간', start:'16:20', end:'17:00'},
    {name:'저녁', start:'', end:''},
  ];
  const periodKey = 'tc06-analysis-periods';
  const time = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const dateTime = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const dateKST = at => new Date(+new Date(at)+9*hour).toISOString().slice(0,10);
  const stamp = value => dateTime.format(new Date(value));
  const startOfDay = day => Date.parse(day+'T00:00:00+09:00');
  const iso = at => new Date(at).toISOString();
  const decimal = value => Number.isFinite(value) ? value.toFixed(1) : '—';
  const count = value => value.toLocaleString('ko-KR');
  const shiftName = shift => shift==='night' ? '야간조' : '주간조';
  const draftDay = el('analysis-day');
  const status = el('analysis-status');
  const defaultHour = new Date(Date.now()+9*hour).getUTCHours();
  const temperature = el('analysis-temperature-chart');
  const macd = el('analysis-macd-chart');
  const views = ['hourly','daily','shifts','periods'];
  let view = 'hourly', data, chart, filter, range, selection, activeEvent, detailPending, summaryPending;
  let periodSettings = defaults;
  try {
    const saved = JSON.parse(localStorage.getItem(periodKey));
    if (Array.isArray(saved) && saved.length<=6 && saved.every(row =>
      row && [row.name,row.start,row.end].every(field => typeof field==='string'))) periodSettings=saved;
  } catch {}

  draftDay.value = dateKST(Date.now()-(defaultHour<8?24*hour:0));
  draftDay.max = dateKST(Date.now());
  el('analysis-shift').value = defaultHour<8 || defaultHour>=20 ? 'night' : 'day';

  function element(tag,className,label) {
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(label!==undefined)node.textContent=label;
    return node;
  }

  function readPeriods() {
    return Array.from(el('analysis-period-list').children,row=>({
      name:row.querySelector('.analysis-slot-name').value.trim(),
      start:row.querySelector('.analysis-slot-start').value,
      end:row.querySelector('.analysis-slot-end').value,
    }));
  }

  function showPeriods(periods) {
    const list=el('analysis-period-list');
    list.replaceChildren();
    periods.forEach((period,index)=>{
      const row=element('div','analysis-slot');
      for(const [field,title,type] of [['name','이름','text'],['start','시작','time'],['end','끝','time']]){
        const label=element('label','',title);
        const input=element('input','analysis-slot-'+field);
        input.type=type;
        if(type==='text')input.maxLength=24;
        input.value=period[field];
        input.setAttribute('aria-label',(index+1)+'번 시간대 '+title);
        label.append(input);
        row.append(label);
      }
      const remove=element('button','secondary','삭제');
      remove.type='button';
      remove.setAttribute('aria-label',(index+1)+'번 시간대 삭제');
      remove.addEventListener('click',()=>showPeriods(readPeriods().filter((_,i)=>i!==index)));
      row.append(remove);
      list.append(row);
    });
    el('analysis-add-period').disabled=periods.length>=6;
  }

  function setStatus(message,error=false){
    status.textContent=message;
    status.dataset.state=error?'error':'ok';
  }

  function shiftRange(day,shift) {
    const start=startOfDay(day)+(shift==='night'?20:8)*hour;
    return {start:iso(start),end:iso(start+12*hour),shift};
  }

  async function fetchAnalysis(day, days, options, controller) {
    const params=new URLSearchParams({
      day,days,change_c:options.change,window_minutes:options.window,
    });
    if(options.periods.length)params.set('periods',options.periods.map(p=>p.start+'-'+p.end).join(','));
    const timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch('/api/analysis?'+params,{cache:'no-store',signal:controller.signal});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'온도 기록을 불러오지 못했습니다.');
      if(!['hourly','daily','shifts','periods','series','events'].every(key=>Array.isArray(result[key]))) {
        throw Error('온도 분석 응답을 확인할 수 없습니다.');
      }
      return result;
    }finally{
      clearTimeout(timeout);
    }
  }

  async function load() {
    if (!el('analysis-form').reportValidity()) return;
    const draft=readPeriods();
    if(draft.some(row=>(row.start||row.end)&&(!row.start||!row.end||row.end<=row.start))){
      el('analysis-period-settings').open=true;
      setStatus('지정 시간대의 시작·종료 시각을 모두 입력하고, 종료를 시작보다 늦게 설정하세요.',true);
      return;
    }
    const options={
      shift:el('analysis-shift').value,
      change:el('analysis-change').value,
      window:el('analysis-window').value,
      periods:draft.flatMap(({name,start,end},index)=>start?[{name:name||'시간대 '+(index+1),start,end}]:[]),
    };
    try{localStorage.setItem(periodKey,JSON.stringify(draft));}catch{}
    summaryPending?.abort();
    detailPending?.abort();
    detailPending=null;
    const controller=new AbortController();
    summaryPending=controller;
    data=null;
    el('analysis-content').hidden=true;
    el('analysis-load').disabled=true;
    setStatus('저장된 실측 온도를 불러오고 있습니다…');
    try{
      const response=await fetchAnalysis(draftDay.value,el('analysis-days').value, options,controller);
      if(summaryPending!==controller)return;
      data=response;
      chart=data;
      filter=options;
      range=null;
      selection=null;
      activeEvent=null;
      draftDay.min=data.oldest_day;
      draftDay.max=data.today;
      el('analysis-content').hidden=false;
      setStatus(data.day+' · '+shiftName(filter.shift)+' · '+filter.window+'분 내 '+Number(filter.change)+'℃ 이상 변동 · 한국시간');
      showSummary();
      showDetail();
    }catch(error){
      if(summaryPending===controller)setStatus(error.name==='AbortError'?'조회 시간이 초과됐습니다. 다시 조회해 주세요.':error.message,true);
    }finally{
      if(summaryPending===controller){
        summaryPending=null;
        el('analysis-load').disabled=false;
      }
    }
  }

  function rowLabel(row) {
    const day=dateKST(row.start).slice(5);
    if(view==='daily')return day;
    const times=time.format(new Date(row.start))+'~'+time.format(new Date(row.end));
    if(view==='hourly')return dateKST(row.start)===data.day?times:day+' '+times;
    if(view==='shifts')return day+' '+shiftName(row.shift);
    return day+' '+(filter.periods[row.period_index]?.name||'시간대')+' · '+times;
  }

  function rowKey(row){return row.start+'/'+row.end+'/'+(row.period_index??'');}

  function showSummary(){
    const window=shiftRange(data.day,filter.shift);
    let rows=data[view];
    if(view==='hourly')rows=rows.filter(row=>row.start>=window.start&&row.start<window.end);
    if(view==='shifts')rows=rows.filter(row=>row.shift===filter.shift);
    for(const key of views)el('analysis-'+key).setAttribute('aria-pressed',String(key===view));
    const hints={
      hourly:'선택한 12시간을 시간별로 집계합니다. 야간조의 자정 이후에는 다음 날 날짜가 붙습니다.',
      daily:'날짜별 00:00~24:00 집계입니다. 날짜를 누르면 해당 날짜의 선택한 조를 보여줍니다.',
      shifts:'주간 08:00~20:00, 야간 20:00~다음 날 08:00입니다. 날짜는 근무 시작일입니다.',
      periods:'지정 시간대별 집계입니다. 시간대가 겹치면 해당 기록이 각 구간에 포함됩니다.',
    };
    el('analysis-summary-note').textContent=hints[view]+' 막대 위쪽은 급등, 아래쪽은 급락입니다. —는 비교할 실측이 부족한 구간입니다.';

    const tbody=el('analysis-rows'), bars=el('analysis-bars');
    tbody.replaceChildren();
    bars.replaceChildren();
    if(!rows.length){
      const row=element('tr'), cell=element('td','analysis-note',view==='periods'?'설정한 시간대에 조회 가능한 집계가 없습니다.':'아직 시작하지 않은 근무 구간입니다.');
      cell.colSpan=8;
      row.append(cell);
      tbody.append(row);
      return;
    }
    const scale=Math.max(1,...rows.flatMap(row=>[row.rises,row.falls]));
    for(const stats of rows){
      const label=rowLabel(stats);
      const row=element('tr'), heading=element('th');
      heading.scope='row';
      const jump=element('button','analysis-row-link',label);
      jump.type='button';
      jump.dataset.range=rowKey(stats);
      jump.addEventListener('click',()=>selectRow(stats));
      heading.append(jump);
      row.append(heading);
      const surgeCounts=stats.comparable_pairs===0?['—','—']:[count(stats.rises),count(stats.falls)];
      const values=[decimal(stats.average),...surgeCounts,decimal(stats.low),decimal(stats.high),count(stats.samples),count(stats.invalid_samples)];
      values.forEach((value,i)=>row.append(element('td',i===1?'analysis-up':i===2?'analysis-down':'',value)));
      tbody.append(row);

      const bar=element('button','analysis-bar');
      bar.type='button';
      const barCaption=stats.comparable_pairs===0?'비교할 실측 부족':'급등 '+stats.rises+'회 · 급락 '+stats.falls+'회';
      bar.setAttribute('aria-label',label+' '+barCaption);
      bar.title=label+' · '+barCaption;
      bar.dataset.range=rowKey(stats);
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 32 48');
      svg.setAttribute('aria-hidden','true');
      function line(x,y,w,h,style) {
        const rect=document.createElementNS(svg.namespaceURI,'rect');
        for(const [key,value] of Object.entries({x,y,width:w,height:h,class:style}))rect.setAttribute(key,value);
        svg.append(rect);
      }
      const up=stats.rises*20/scale, down=stats.falls*20/scale;
      line(0,23.5,32,1,'analysis-bar-axis');
      line(9,24-up,14,up,'analysis-bar-up');
      line(9,24,14,down,'analysis-bar-down');
      bar.append(svg,element('span','',view==='hourly'?time.format(new Date(stats.start)):dateKST(stats.start).slice(5)));
      bar.addEventListener('click',()=>selectRow(stats));
      bars.append(bar);
    }
    markRow();
  }

  function markRow(){
    for(const button of screen.querySelectorAll('[data-range]')){
      if(selection===button.dataset.range)button.setAttribute('aria-current','true');
      else button.removeAttribute('aria-current');
    }
  }

  async function selectRow(row){
    const day=dateKST(row.start);
    detailPending?.abort();
    detailPending=null;
    activeEvent=null;
    selection=rowKey(row);
    range=view==='daily'?shiftRange(day,filter.shift):row;
    markRow();
    const covers=candidate=>candidate&&Date.parse(range.start)>=startOfDay(candidate.day)&&
      Date.parse(range.end)<=startOfDay(candidate.day)+32*hour;
    if(!covers(chart)&&covers(data))chart=data;
    if(!covers(chart)){
      const controller=new AbortController();
      detailPending=controller;
      chart=null;
      showDetail();
      try{
        const result=await fetchAnalysis(day,1,filter,controller);
        if(detailPending!==controller)return;
        chart=result;
      }catch(error){
        if(detailPending!==controller)return;
        el('analysis-chart-note').textContent=error.name==='AbortError'?'구간 조회 시간이 초과됐습니다. 다시 선택해 주세요.':error.message;
        return;
      }finally{
        if(detailPending===controller)detailPending=null;
      }
    }
    showDetail();
    el('analysis-detail').scrollIntoView({block:'start'});
  }

  function chartRange(){
    const window=range||shiftRange(data.day,filter.shift);
    if(!activeEvent)return window;
    const lastPoint=chart.series.at(-1);
    const availableEnd=lastPoint?Date.parse(lastPoint.time)+minute:Date.parse(activeEvent.end)+minute;
    return {
      start:iso(Math.max(startOfDay(chart.day),Date.parse(activeEvent.start)-10*minute)),
      end:iso(Math.min(availableEnd,Date.parse(activeEvent.end)+10*minute)),
    };
  }

  function redraw(){
    if(screen.hidden||!data)return;
    const bounds=chartRange();
    const indicators={
      average:el('analysis-average').checked,
      bands:el('analysis-bands').checked,
      macd:el('analysis-macd-toggle').checked,
    };
    const result=window.TC06AnalysisChart?.draw({
      temperature,macd,series:chart?.series??[],from:bounds.start,to:bounds.end,indicators,event:activeEvent,
    });
    macd.toggleAttribute('hidden',!result?.macdReady);
    el('analysis-average-legend').hidden=!indicators.average;
    el('analysis-band-legend').hidden=!indicators.bands;
    el('analysis-macd-legend').hidden=!result?.macdReady;
    const unavailable=[];
    if(indicators.average&&!result?.averageReady)unavailable.push('5분 이동평균');
    if(indicators.average&&!result?.longAverageReady)unavailable.push('30분 이동평균');
    if(indicators.bands&&!result?.bandsReady)unavailable.push('볼린저 밴드');
    if(indicators.macd&&!result?.macdReady)unavailable.push('MACD');
    el('analysis-chart-note').textContent=!chart?'선택한 구간을 불러오는 중입니다…'
      :!result?.measured?'이 구간에 표시할 실측이 없습니다.'
        :unavailable.length?'연속으로 기록된 1분 실측이 부족합니다 · '+unavailable.join(', ')
          :'실측 1분봉 마지막 값 · 충분한 연속 실측이 있는 구간에 보조지표 표시';
    el('analysis-chart-period').textContent=stamp(bounds.start)+' ~ '+stamp(bounds.end)+' · 한국시간';
  }

  function eventName(event){return event.direction==='up'?'급등':'급락';}
  function signed(value){return (value>0?'+':'')+decimal(value)+'℃';}

  function selectEvent(event, button) {
    activeEvent=event;
    for(const item of el('analysis-events').querySelectorAll('button'))item.setAttribute('aria-pressed',String(item===button));
    const original=el('analysis-original');
    const query=new URLSearchParams({mode:'graph',day:dateKST(event.end),minutes:'1',span:'60',at:event.end});
    original.href='/?'+query;
    original.hidden=false;
    const detail=el('analysis-event-detail');
    detail.hidden=false;
    const qualification=event.qualified_at?' · 첫 기준 도달 '+time.format(new Date(event.qualified_at))+' ('+signed(event.qualified_delta_c)+')':'';
    detail.textContent=eventName(event)+' '+signed(event.delta_c)+' · '+decimal(event.from_c)+'℃ → '+decimal(event.to_c)+'℃ · '+stamp(event.start)+' ~ '+stamp(event.end)+qualification;
    el('analysis-reset-range').hidden=false;
    redraw();
  }

  function showDetail(){
    const events=el('analysis-events');
    events.replaceChildren();
    el('analysis-original').hidden=true;
    el('analysis-event-detail').hidden=true;
    el('analysis-reset-range').hidden=!range;
    if(chart){
      const window=chartRange();
      const selected=chart.events.filter(event=>event.start>=window.start&&event.start<window.end);
      if(!selected.length){
        const hours=chart.hourly.filter(row=>row.start>=window.start&&row.start<window.end);
        const comparable=range?.comparable_pairs??(hours.length&&hours.every(row=>row.comparable_pairs===0)?0:null);
        events.append(element('li','analysis-note',comparable===0
          ?'변동 시간 안에 비교할 연속 실측이 부족합니다.'
          :'선택한 구간에 기준을 넘은 온도 변화가 없습니다.'));
      }
      for(const event of selected){
        const item=element('li');
        const button=element('button','analysis-event');
        button.type='button';
        button.setAttribute('aria-pressed','false');
        button.append(element('strong',event.direction==='up'?'analysis-up':'analysis-down',eventName(event)+' '+signed(event.delta_c)),
          element('span','',stamp(event.start)+' ~ '+time.format(new Date(event.end))));
        button.addEventListener('click',()=>selectEvent(event,button));
        item.append(button);
        events.append(item);
      }
    }
    redraw();
  }

  el('analysis-form').addEventListener('submit',event=>{event.preventDefault();load();});
  el('analysis-shift').addEventListener('change',()=>load());
  el('analysis-day').addEventListener('change',()=>load());
  el('analysis-add-period').addEventListener('click',()=>showPeriods([...readPeriods(),{name:'',start:'',end:''}]));
  for(const key of views)el('analysis-'+key).addEventListener('click',()=>{view=key;showSummary();});
  for(const id of ['analysis-average','analysis-bands','analysis-macd-toggle'])el(id).addEventListener('change',redraw);
  el('analysis-reset-range').addEventListener('click',()=>{
    detailPending?.abort();
    detailPending=null;
    chart=data;
    range=null;
    selection=null;
    activeEvent=null;
    markRow();
    showDetail();
  });
  if('ResizeObserver' in window)new ResizeObserver(redraw).observe(el('analysis-detail'));
  else window.addEventListener('resize',redraw);
  showPeriods(periodSettings);
  window.TC06Analysis={open(){if(data)redraw();else if(!summaryPending)load();}};
})();
