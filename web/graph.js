'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const NS='http://www.w3.org/2000/svg';
  const clock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});
  const stamp=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const day=value=>new Date(value+9*3600000).toISOString().slice(0,10);
  const number=value=>Number.isFinite(value)?value.toFixed(1):'—';
  const shortGapMinutes=3;
  const emptyLabels={overdue:'기록 예정 초과',scheduled:'기록 예정 없음',pending:'기록 대기 중',unknown:'저장 기록 없음 · 적용 간격 미확인'};
  const emptyState=bar=>Object.hasOwn(emptyLabels,bar.empty_state)?bar.empty_state:bar.complete?'unknown':'pending';
  function savedSettings(key){
    try{const value=JSON.parse(localStorage.getItem(key)||'{}');if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}
    return {};
  }
  function element(tag,attributes={},text){const node=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;return node;}
  class Graph {
    constructor(now=Date.now){
      this.now=now;this.data=null;this.error=null;this.pending=null;this.abort=null;this.sequence=0;this.loadedAt=0;this.selectedAt=null;this.followToday=true;
      const saved=savedSettings('tc06-graph-v1');
      const query=new URLSearchParams(location.search);
      this.minutes=Number(query.get('minutes')||saved.minutes||1);if(![1,5,10].includes(this.minutes))this.minutes=1;
      this.span=Number(query.get('span')||saved.span||360);if(![60,360,1440].includes(this.span))this.span=360;
      const currentTime = this.now();
      const today = day(currentTime);
      const dateInput = $('graph-day');
      dateInput.value = query.get('day') || today;
      if (!dateInput.value) dateInput.value = today;
      const at = Date.parse(query.get('at'));
      this.anchorEnd = null;
      // The trend endpoint excludes its end timestamp. Keep the selected record inside the window.
      if (Number.isFinite(at) && at < currentTime && day(at) === dateInput.value) {
        this.anchorEnd = new Date(at + 1).toISOString();
        this.selectedAt = at;
      }
      this.followToday = !this.anchorEnd && dateInput.value === today;
      $('graph-span').value=String(this.span);
      for(const button of document.querySelectorAll('[data-minutes]'))button.addEventListener('click',()=>{
        const minutes=Number(button.dataset.minutes);
        if(minutes===this.minutes)return;
        this.minutes=minutes;this.save();this.load(true,true);
      });
      $('graph-span').addEventListener('change',()=>{if(!this.anchorEnd)this.selectedAt=null;this.span=Number($('graph-span').value);this.save();this.load(true);});
      dateInput.addEventListener('change', () => {
        this.clearAnchor();
        this.followToday = dateInput.value === day(this.now());
        if (!this.followToday) {
          this.span = 1440;
          $('graph-span').value = '1440';
        }
        this.save();
        this.load(true);
      });
      $('graph-live').addEventListener('click', () => {
        this.clearAnchor();
        this.followToday = true;
        dateInput.value = day(this.now());
        this.load(true);
      });
      const svg=$('trend-chart');
      svg.addEventListener('pointermove',event=>{if(event.pointerType==='mouse')this.pick(event);});
      svg.addEventListener('pointerleave',()=>this.showSelection());
      svg.addEventListener('click',event=>this.pick(event,true));
      $('quality-chart').addEventListener('click',event=>this.pick(event,true));
      svg.addEventListener('keydown',event=>{if(!this.data?.bars.length)return;const last=this.data.bars.length-1;
        if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
          event.preventDefault();event.stopPropagation();
          const selected=this.indexAt(this.selectedAt);
          const next=event.key==='Home'?0:event.key==='End'||selected<0?last:Math.max(0,Math.min(last,selected+(event.key==='ArrowLeft'?-1:1)));
          this.select(next);
        }});
      if('ResizeObserver'in window)new ResizeObserver(()=>this.draw()).observe($('chart-wrap'));else window.addEventListener('resize',()=>this.draw());
      this.setupTheme();this.setupOptions();this.controls();
    }
    clearAnchor() {
      this.anchorEnd = null;
      this.selectedAt = null;
      const url = new URL(location.href);
      if (!url.searchParams.has('day') && !url.searchParams.has('at')) return;
      url.searchParams.delete('day');
      url.searchParams.delete('at');
      history.replaceState(null, '', url);
    }
    setupTheme(){
      const select=$('graph-theme');
      if(!select)return;
      const screen=$('graph-screen'),key='tc06-graph-theme';
      let theme='light';
      try{if(localStorage.getItem(key)==='dark')theme='dark';}catch{}
      select.value=theme;
      screen.dataset.theme=select.value;
      select.addEventListener('change',()=>{
        screen.dataset.theme=select.value;
        try{localStorage.setItem(key,select.value);}catch{}
      });
    }
    validOptions(options){
      const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=9999.9;
      return options&&['auto','fixed'].includes(options.axis)&&typeof options.reference==='boolean'&&
        (options.axis==='auto'||(finite(options.min)&&finite(options.max)&&options.max-options.min>=0.099999))&&
        (!options.reference||(finite(options.target)&&finite(options.low)&&finite(options.high)&&options.high-options.low>=0.099999));
    }
    setupOptions(){
      const defaults={axis:'auto',min:null,max:null,reference:false,target:null,low:null,high:null};
      const saved=savedSettings('tc06-graph-view-v1');
      this.options=this.validOptions(saved)?saved:defaults;
      const fields={axis:'axis-mode',min:'axis-min',max:'axis-max',target:'target-value',low:'reference-min',high:'reference-max'};
      for(const [key,id]of Object.entries(fields))$(id).value=this.options[key]??'';
      $('reference-enabled').checked=this.options.reference;
      const toggle=()=>{for(const id of ['axis-min','axis-max'])$(id).disabled=$('axis-mode').value!=='fixed';for(const id of ['target-value','reference-min','reference-max'])$(id).disabled=!$('reference-enabled').checked;};
      $('axis-mode').addEventListener('change',toggle);$('reference-enabled').addEventListener('change',toggle);toggle();
      $('graph-options-form').noValidate=true;
      $('graph-options-form').addEventListener('submit',event=>{event.preventDefault();
        const numeric=id=>$(id).value.trim()===''?null:Number($(id).value);
        const next={axis:$('axis-mode').value,min:numeric('axis-min'),max:numeric('axis-max'),reference:$('reference-enabled').checked,target:numeric('target-value'),low:numeric('reference-min'),high:numeric('reference-max')};
        if(!this.validOptions(next)){$('graph-options-error').textContent='축·참고 범위는 최솟값이 최댓값보다 작아야 합니다. 사용하는 항목에 −9999.9~9999.9℃의 숫자를 모두 입력하세요.';return;}
        this.options=next;try{localStorage.setItem('tc06-graph-view-v1',JSON.stringify(next));$('graph-options-error').textContent='';}catch{$('graph-options-error').textContent='브라우저 저장소를 사용할 수 없어 이번 화면에만 적용했습니다.';}this.draw();
      });
    }
    save(){try{localStorage.setItem('tc06-graph-v1',JSON.stringify({minutes:this.minutes,span:this.span}));}catch{}this.controls();}
    controls(){for(const button of document.querySelectorAll('[data-minutes]'))button.setAttribute('aria-pressed',String(Number(button.dataset.minutes)===this.minutes));}
    async load(force=false,keepWindow=false){
      if(document.body.dataset.mode!=='graph'||document.hidden)return false;
      if(this.followToday)$('graph-day').value=day(this.now());
      const date=$('graph-day').value;if(!date)return false;
      const key=`${date}/${this.minutes}/${this.span}/${this.anchorEnd||''}`;
      const rangeKey=`${date}/${this.span}`;
      const params=new URLSearchParams({day:date,minutes:this.minutes,span:this.span});
      if(this.anchorEnd)params.set('as_of',this.anchorEnd);
      else if(keepWindow&&this.followToday&&this.lastWindow?.key===rangeKey)params.set('as_of',this.lastWindow.end);
      const requestKey=params.toString();
      if(this.pendingKey===requestKey&&this.pending)return this.pending;
      if(!force&&this.key===key&&Date.now()-this.loadedAt<30000){this.draw();return !this.error;}
      if(this.key!==key){this.data=null;this.error=null;this.draw();}
      this.abort?.abort();const sequence=++this.sequence;const controller=new AbortController();this.abort=controller;this.pendingKey=requestKey;
      $('graph-status').textContent='저장 이력을 불러오고 있습니다…';
      const timeout=setTimeout(()=>controller.abort(),20000);
      this.pending=(async()=>{
        try{
          const response=await fetch(`/api/trend?${params}`,{cache:'no-store',signal:controller.signal});
          const data=await response.json();if(!response.ok)throw Error(data.error||'그래프 조회 실패');if(sequence!==this.sequence)return null;
          this.error=null;this.data=data;this.key=key;this.loadedAt=Date.now();this.lastWindow={key:rangeKey,end:data.end};
          $('graph-day').min=data.oldest_day;$('graph-day').max=day(Date.parse(data.server_now));
          $('graph-status').textContent=`조회 ${stamp.format(new Date(data.server_now))} · 실측 ${data.samples.toLocaleString('ko-KR')}건 · 판독 실패 ${data.invalid_samples}건 · 추정 ${(data.estimates||[]).length}건 · ${window.TC06Collection?.label||'1분'}마다 갱신`;
          this.draw();
          return true;
        }catch(error){if(sequence===this.sequence){this.error=this.data?'조회 연결 실패 · 마지막 조회 '+stamp.format(new Date(this.data.server_now))+'의 그래프를 표시합니다. 새로고침으로 다시 확인하세요.':'저장 이력을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.';$('graph-status').textContent=this.data?'연결 확인 필요 · 마지막 조회 그래프를 표시하고 있습니다.':this.error;this.draw();}}
        finally{clearTimeout(timeout);if(sequence===this.sequence){this.pending=null;this.pendingKey=null;}}
        return sequence===this.sequence?false:null;
      })();return this.pending;
    }
    draw(){
      if(document.body.dataset.mode!=='graph')return;
      const svg=$('trend-chart'),box=$('chart-wrap').getBoundingClientRect();
      const width=Math.max(320,box.width),height=Math.max(240,box.height),left=width<550?58:84,right=24,top=30,bottom=44;
      const plotW=width-left-right,plotH=height-top-bottom;
      svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.replaceChildren();$('quality-chart').replaceChildren();$('graph-tooltip').hidden=true;
      this.layout={width,height,left,top,plotW,plotH};
      $('graph-bridge-legend').hidden=true;
      $('graph-long-bridge-legend').hidden=true;
      const data=this.data,bars=data?.bars||[],valid=bars.filter(bar=>bar.count>0);
      $('graph-data-notice').hidden=!this.error;$('graph-data-notice').textContent=this.error||'';
      $('graph-measured').textContent=data?data.samples.toLocaleString('ko-KR'):'—';
      $('graph-failed').textContent=data?data.invalid_samples.toLocaleString('ko-KR'):'—';
      $('graph-missing').textContent=data?String(bars.filter(bar=>!bar.count&&!bar.invalid_count&&emptyState(bar)==='overdue').length):'—';
      $('graph-estimated').textContent=data?String((data.estimates||[]).length):'—';
      $('axis-notice').textContent=(this.options.axis==='fixed'?`고정 범위 ${this.options.min}~${this.options.max}℃`:'자동 범위')+(this.options.reference?' · 참고선 켜짐':' · 참고선 꺼짐');
      const estimates=(data?.estimates||[]).filter(item=>Number.isFinite(item.value_c)&&Number.isFinite(item.based_on_value_c));
      const forecastValues=estimates.flatMap(item=>[item.value_c,item.based_on_value_c]);
      $('graph-low').textContent=valid.length?number(data.low)+' ℃':'—';$('graph-high').textContent=valid.length?number(data.high)+' ℃':'—';
      $('graph-period').textContent=data?`${stamp.format(new Date(data.start))} – ${stamp.format(new Date(data.end))} · 한국시간`:'조회 시간 확인 중';
      $('graph-empty').hidden=valid.length>0||estimates.length>0;
      $('graph-empty').textContent=data?'저장된 정상 온도 기록이 없습니다. 수집 기록이 쌓이면 표시됩니다.':this.error||'저장된 온도 이력을 불러오는 중입니다.';
      if(!bars.length){$('graph-detail').textContent=this.error?'기록을 다시 조회하려면 새로고침을 눌러 주세요.':'조회 중에는 이전 온도나 기본값으로 그래프를 만들지 않습니다.';return;}

      const range=[...forecastValues,...(valid.length?[data.low,data.high]:[])];if(this.options.reference)range.push(this.options.target,this.options.low,this.options.high);
      const rawLow=range.length?Math.min(...range):0,rawHigh=range.length?Math.max(...range):100,pad=Math.max(1,(rawHigh-rawLow)*.12);
      const rough=(rawHigh-rawLow+pad*2)/4,power=10**Math.floor(Math.log10(rough)),step=([1,2,5,10].find(n=>n*power>=rough)||10)*power;
      const min=this.options.axis==='fixed'?this.options.min:Math.floor((rawLow-pad)/step)*step,max=this.options.axis==='fixed'?this.options.max:Math.ceil((rawHigh+pad)/step)*step;
      if(this.options.axis==='fixed'&&((valid.length&&(data.low<min||data.high>max))||forecastValues.some(value=>value<min||value>max)))$('axis-notice').textContent+=' · 범위 밖 온도 있음';
      if(this.options.reference&&[this.options.target,this.options.low,this.options.high].some(value=>value<min||value>max))$('axis-notice').textContent+=' · 범위 밖 참고선 있음';
      this.axis={min,max};
      const start=Date.parse(data.start),end=Date.parse(data.end),period=data.minutes*60000;
      const timeX=time=>left+(time-start)/(end-start)*plotW;
      const slots=bars.map(bar=>{
        const time=Date.parse(bar.time),from=Math.max(time,start),to=Math.min(time+period,end);
        return {time,from,to,center:(from+to)/2};
      });
      Object.assign(this.layout,{start,end,period,slots,timeX});
      const y=value=>top+(max-value)/(max-min)*plotH,x=index=>timeX(slots[index].center);
      const grid=element('g',{'class':'chart-grid'});svg.append(grid);
      for(let i=0;i<=4;i++){const value=min+(max-min)*i/4,yy=y(value);grid.append(element('line',{x1:left,x2:width-right,y1:yy,y2:yy}),element('text',{x:left-12,y:yy+5,'text-anchor':'end'},number(value)));}
      grid.append(element('text',{x:left-12,y:16,'text-anchor':'end'},'℃'));
      const ticks=width<550?3:7;
      for(let i=0;i<ticks;i++){
        const time=start+(end-start)*i/(ticks-1);
        grid.append(element('text',{x:timeX(time),y:height-12,'text-anchor':i===0?'start':i===ticks-1?'end':'middle'},clock.format(new Date(time))));
      }
      const defs=element('defs'),clip=element('clipPath',{id:'temperature-clip'});clip.append(element('rect',{x:left,y:top,width:plotW,height:plotH}));defs.append(clip);svg.append(defs);
      const plot=element('g',{'clip-path':'url(#temperature-clip)'});svg.append(plot);
      if(this.options.reference){const lowY=y(this.options.high),highY=y(this.options.low);
        plot.append(element('rect',{x:left,y:lowY,width:plotW,height:highY-lowY,'class':'chart-reference-range'}));
        plot.append(element('line',{x1:left,x2:width-right,y1:y(this.options.target),y2:y(this.options.target),'class':'chart-target'}));
        plot.append(element('text',{x:width-right-6,y:y(this.options.target)-6,'text-anchor':'end','class':'reference-label'},'목표 '+number(this.options.target)+'℃'));
        plot.append(element('text',{x:left+6,y:Math.max(top+16,lowY+16),'class':'reference-label'},'참고 '+number(this.options.low)+'~'+number(this.options.high)+'℃'));
      }
      let path='',previous=-2;
      const bridges=element('g',{'class':'bridges'});
      let shortBridge=false,longBridge=false;
      bars.forEach((bar,i)=>{
        if(!bar.count)return;
        const point=x(i).toFixed(2)+','+y(bar.close).toFixed(2);
        path+=(previous===i-1?'L':'M')+point;
        if(data.minutes===1&&previous>=0&&i-previous>1){
          const gapMinutes=i-previous-1,isLong=gapMinutes>shortGapMinutes;
          if(isLong)longBridge=true;else shortBridge=true;
          const pathClass=isLong?'chart-bridge chart-bridge-long':'chart-bridge';
          bridges.append(element('path',{d:`M${x(previous)},${y(bars[previous].close)} L${point}`,'class':pathClass}));
          for(let gap=previous+1;gap<i;gap++)slots[gap].gapMinutes=gapMinutes;
        }
        previous=i;
      });
      $('graph-bridge-legend').hidden=!shortBridge;
      $('graph-long-bridge-legend').hidden=!longBridge;
      if(bridges.childElementCount)plot.append(bridges);
      plot.append(element('path',{d:path,'class':'chart-close'}));
      const candles=element('g',{'class':'candles'});plot.append(candles);
      bars.forEach((bar,i)=>{
        const xx=x(i);if(!bar.count)return;
        const tone=bar.close>bar.open?'up':bar.close<bar.open?'down':'flat',w=Math.max(.8,Math.min(22,(timeX(slots[i].to)-timeX(slots[i].from))*.64));
        candles.append(element('line',{x1:xx,x2:xx,y1:y(bar.high),y2:y(bar.low),'class':`wick ${tone}`}));
        candles.append(element('rect',{x:xx-w/2,y:Math.min(y(bar.open),y(bar.close))-.6,width:w,height:Math.max(1.2,Math.abs(y(bar.open)-y(bar.close))),'class':`candle ${tone}${bar.complete?'':' forming'}`}));
      });
      const forecast=element('g',{'class':'estimates'});plot.append(forecast);
      for(const item of estimates){const x1=Math.max(left,timeX(Date.parse(item.based_on_at))),x2=Math.min(width-right,timeX(Date.parse(item.estimated_at)));
        const anchor=Date.parse(item.based_on_at),target=Date.parse(item.estimated_at),clipped=Math.max(anchor,Date.parse(data.start));
        const startValue=item.based_on_value_c+(item.value_c-item.based_on_value_c)*(clipped-anchor)/Math.max(1,target-anchor);
        forecast.append(element('path',{d:'M'+x1+','+y(startValue)+'L'+x2+','+y(item.value_c),'class':'chart-estimate'}),element('circle',{cx:x2,cy:y(item.value_c),r:4,'class':'estimate-point'}));}
      this.cross=element('line',{x1:0,x2:0,y1:top,y2:top+plotH,'class':'chart-cross',visibility:'hidden'});svg.append(this.cross);
      const quality=$('quality-chart');quality.setAttribute('viewBox',`0 0 ${width} 18`);
      bars.forEach((bar,i)=>{
        const state=bar.count?(bar.invalid_count?'mixed':'good'):bar.invalid_count?'failed':emptyState(bar);
        const from=timeX(slots[i].from),to=timeX(slots[i].to);
        const rect=element('rect',{x:from,y:2,width:Math.max(.1,to-from-.4),height:14,'class':'quality-'+state});
        const label=emptyLabels[state]||`실측 ${bar.count}건 · 실패 ${bar.invalid_count}건`;
        rect.append(element('title',{},`${stamp.format(new Date(slots[i].from))} · ${label}`));quality.append(rect);
      });
      for(const item of estimates){const cx=timeX(Date.parse(item.estimated_at));quality.append(element('circle',{cx,cy:9,r:3.5,'class':'quality-estimated'}));}
      this.showSelection();
    }
    indexAt(time){
      const {start,end,slots,period}=this.layout||{};
      if(time===null||!slots?.length||time<start||time>=end)return -1;
      return Math.floor((time-slots[0].time)/period);
    }
    pick(event,pin=false){
      if(!this.data?.bars.length||!this.layout?.slots)return;
      const rect=$('trend-chart').getBoundingClientRect();
      const {width,left,plotW,start,end}=this.layout;
      const x=(event.clientX-rect.left)*width/rect.width;
      const time=start+(x-left)/plotW*(end-start);
      const index=this.indexAt(time);
      if(index<0){if(!pin)this.showSelection();return;}
      if(pin)this.select(index);else this.detail(index,true,false);
    }
    select(index){
      this.selectedAt=this.layout.slots[index].center;
      this.detail(index,true);
    }
    showSelection(){
      $('graph-tooltip').hidden=true;
      const index=this.indexAt(this.selectedAt);
      if(index>=0&&this.data?.bars[index]){this.detail(index);return;}
      this.selectedAt=null;
      this.cross?.setAttribute('visibility','hidden');
      if(this.data?.bars.length)$('graph-detail').textContent='그래프나 상태 띠를 누르거나 좌우 방향키로 봉 상세를 확인하세요.';
    }
    detail(index,showTooltip=false,showDetail=true){
      const bar=this.data.bars[index],slot=this.layout.slots[index];
      const x=this.layout.timeX(slot.center);
      this.cross?.setAttribute('x1',x);this.cross?.setAttribute('x2',x);this.cross?.setAttribute('visibility','visible');
      const time=stamp.format(new Date(slot.from));
      const estimates=(this.data.estimates||[]).filter(item=>Date.parse(item.estimated_at)>=slot.from&&Date.parse(item.estimated_at)<slot.to);
      let detail=bar.count?`${time} · 첫값 ${number(bar.open)} · 최고 ${number(bar.high)} · 최저 ${number(bar.low)} · 마지막 ${number(bar.close)} ℃ · 정상 ${bar.count}건 / 실패 ${bar.invalid_count}건`:`${time} · ${bar.invalid_count?'정상 판독 없음 / 실패 '+bar.invalid_count+'건':emptyLabels[emptyState(bar)]}`;
      if(slot.from>slot.time)detail+=' · 조회 시작 이후만 집계';
      if(!bar.complete&&(bar.count||bar.invalid_count))detail+=' · 진행 중인 봉';
      if(slot.gapMinutes)detail+=` · 실측 없는 1분봉 ${slot.gapMinutes}개 · 양쪽 실측점 연결`;
      if(estimates.length)detail+=' · 추정 '+estimates.map(item=>'약 '+number(item.value_c)+' ℃').join(', ')+' (실측 아님·정상 통계 제외)';
      if(showDetail&&$('graph-detail').textContent!==detail)$('graph-detail').textContent=detail;
      if(!showTooltip)return;
      const tip=$('graph-tooltip');tip.textContent=detail;tip.hidden=false;
      const tipWidth=Math.min(330,this.layout.width-24);tip.style.width=tipWidth+'px';
      tip.style.left=Math.max(12,Math.min(this.layout.width-tipWidth-12,x-tipWidth/2))+'px';
      const valueY=bar.count?this.layout.top+(this.axis.max-bar.close)/(this.axis.max-this.axis.min)*this.layout.plotH:this.layout.top+this.layout.plotH/2;
      tip.style.top=Math.max(12,Math.min(this.layout.height-tip.offsetHeight-12,valueY+12))+'px';

    }
  }
  globalThis.TC06Graph={Graph};
})();
