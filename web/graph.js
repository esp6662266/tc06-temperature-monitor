'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const NS='http://www.w3.org/2000/svg';
  const clock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});
  const stamp=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const day=value=>new Date(value+9*3600000).toISOString().slice(0,10);
  const number=value=>Number.isFinite(value)?value.toFixed(1):'—';
  function element(tag,attributes={},text){const node=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;return node;}
  class Graph {
    constructor(now=Date.now){
      this.now=now;this.data=null;this.pending=null;this.abort=null;this.sequence=0;this.loadedAt=0;this.selected=-1;this.followToday=true;
      let saved={};try{saved=JSON.parse(localStorage.getItem('tc06-graph-v1')||'{}');}catch{}
      const query=new URLSearchParams(location.search);
      this.minutes=Number(query.get('minutes')||saved.minutes||1);if(![1,5,10].includes(this.minutes))this.minutes=1;
      this.span=Number(query.get('span')||saved.span||360);if(![60,360,1440].includes(this.span))this.span=360;
      $('graph-day').value=day(this.now());$('graph-span').value=String(this.span);
      for(const button of document.querySelectorAll('[data-minutes]'))button.addEventListener('click',()=>{this.minutes=Number(button.dataset.minutes);this.save();this.load(true);});
      $('graph-span').addEventListener('change',()=>{this.span=Number($('graph-span').value);this.save();this.load(true);});
      $('graph-day').addEventListener('change',()=>{this.followToday=$('graph-day').value===day(this.now());if(!this.followToday){this.span=1440;$('graph-span').value='1440';}this.save();this.load(true);});
      $('graph-live').addEventListener('click',()=>{this.followToday=true;$('graph-day').value=day(this.now());this.load(true);});
      $('graph-refresh').addEventListener('click',()=>this.load(true));
      const svg=$('trend-chart');svg.addEventListener('pointermove',event=>this.pick(event));svg.addEventListener('pointerdown',event=>this.pick(event));
      svg.addEventListener('keydown',event=>{if(!this.data?.bars.length)return;const last=this.data.bars.length-1;
        if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();this.selected=event.key==='Home'?0:event.key==='End'?last:Math.max(0,Math.min(last,(this.selected<0?last:this.selected)+(event.key==='ArrowLeft'?-1:1)));this.detail();}});
      if('ResizeObserver'in window)new ResizeObserver(()=>this.draw()).observe($('chart-wrap'));else window.addEventListener('resize',()=>this.draw());
      this.controls();
    }
    save(){try{localStorage.setItem('tc06-graph-v1',JSON.stringify({minutes:this.minutes,span:this.span}));}catch{}this.controls();}
    controls(){for(const button of document.querySelectorAll('[data-minutes]'))button.setAttribute('aria-pressed',String(Number(button.dataset.minutes)===this.minutes));}
    async load(force=false){
      if(document.body.dataset.mode!=='graph'||document.hidden)return;
      if(this.followToday)$('graph-day').value=day(this.now());
      const date=$('graph-day').value;if(!date)return;
      const key=`${date}/${this.minutes}/${this.span}`;
      if(!force&&this.key===key&&Date.now()-this.loadedAt<30000){this.draw();return;}
      if(!force&&this.pendingKey===key&&this.pending)return this.pending;
      if(this.key!==key){this.data=null;this.selected=-1;this.draw();}
      this.abort?.abort();const sequence=++this.sequence;const controller=new AbortController();this.abort=controller;this.pendingKey=key;
      $('graph-status').textContent='저장 이력을 불러오고 있습니다…';
      const timeout=setTimeout(()=>controller.abort(),20000);
      this.pending=(async()=>{
        try{
          const response=await fetch(`/api/trend?day=${encodeURIComponent(date)}&minutes=${this.minutes}&span=${this.span}`,{cache:'no-store',signal:controller.signal});
          const data=await response.json();if(!response.ok)throw Error(data.error||'그래프 조회 실패');if(sequence!==this.sequence)return;
          this.data=data;this.key=key;this.loadedAt=Date.now();this.selected=-1;
          $('graph-day').min=data.oldest_day;$('graph-day').max=day(Date.parse(data.server_now));
          $('graph-status').textContent=`조회 ${stamp.format(new Date(data.server_now))} · ${data.samples.toLocaleString('ko-KR')}건 · 판독 실패 ${data.invalid_samples}건 · 추정 ${(data.estimates||[]).length}건 · 1분마다 갱신`;
          this.draw();
        }catch(error){if(sequence===this.sequence){$('graph-status').textContent=this.data?'연결 확인 필요 · 마지막 조회 그래프를 표시하고 있습니다.':error.message||'그래프를 불러올 수 없습니다.';if(!this.data)this.draw();}}
        finally{clearTimeout(timeout);if(sequence===this.sequence){this.pending=null;this.pendingKey=null;}}
      })();return this.pending;
    }
    draw(){
      if(document.body.dataset.mode!=='graph')return;
      const svg=$('trend-chart'),box=$('chart-wrap').getBoundingClientRect();
      const width=Math.max(320,box.width),height=Math.max(240,box.height),left=width<550?58:84,right=24,top=30,bottom=44;
      const plotW=width-left-right,plotH=height-top-bottom;
      svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.replaceChildren();
      this.layout={width,height,left,top,plotW,plotH};
      const data=this.data,bars=data?.bars||[],valid=bars.filter(bar=>bar.count>0);
      const estimates=(data?.estimates||[]).filter(item=>Number.isFinite(item.value_c)&&Number.isFinite(item.based_on_value_c));
      const forecastValues=estimates.flatMap(item=>[item.value_c,item.based_on_value_c]);
      $('graph-low').textContent=valid.length?number(data.low)+' ℃':'—';$('graph-high').textContent=valid.length?number(data.high)+' ℃':'—';
      $('graph-period').textContent=data?`${stamp.format(new Date(data.start))} – ${stamp.format(new Date(data.end))} · 한국시간`:'조회할 시간 범위를 선택하세요';
      $('graph-empty').hidden=valid.length>0||estimates.length>0;
      $('graph-empty').textContent=data?'저장된 정상 온도 기록이 없습니다. 수집 기록이 쌓이면 표시됩니다.':'저장된 온도 이력을 불러오세요.';
      if(!bars.length){$('graph-detail').textContent='기본값 38도는 그래프 기록에 넣지 않습니다.';return;}

      const range=[...forecastValues,...(valid.length?[data.low,data.high]:[])];
      const rawLow=range.length?Math.min(...range):0,rawHigh=range.length?Math.max(...range):100,pad=Math.max(1,(rawHigh-rawLow)*.12);
      const rough=(rawHigh-rawLow+pad*2)/4,power=10**Math.floor(Math.log10(rough)),step=([1,2,5,10].find(n=>n*power>=rough)||10)*power;
      const min=Math.floor((rawLow-pad)/step)*step,max=Math.ceil((rawHigh+pad)/step)*step;
      const y=value=>top+(max-value)/(max-min)*plotH,x=index=>left+(index+.5)*plotW/bars.length;
      const grid=element('g',{'class':'chart-grid'});svg.append(grid);
      for(let value=min;value<=max+step*.01;value+=step){const yy=y(value);grid.append(element('line',{x1:left,x2:width-right,y1:yy,y2:yy}),element('text',{x:left-12,y:yy+5,'text-anchor':'end'},number(value)));}
      grid.append(element('text',{x:left-12,y:16,'text-anchor':'end'},'℃'));
      const ticks=width<550?3:7;
      for(let i=0;i<ticks;i++){const index=Math.round(i*(bars.length-1)/(ticks-1)),xx=x(index);grid.append(element('text',{x:xx,y:height-12,'text-anchor':i===0?'start':i===ticks-1?'end':'middle'},clock.format(new Date(bars[index].time))));}
      let path='',previous=-2;
      bars.forEach((bar,i)=>{if(!bar.count)return;path+=(previous===i-1?'L':'M')+x(i).toFixed(2)+','+y(bar.close).toFixed(2);previous=i;});
      svg.append(element('path',{d:path,'class':'chart-close'}));
      const candles=element('g',{'class':'candles'});svg.append(candles);
      bars.forEach((bar,i)=>{
        const xx=x(i);if(!bar.count){if(bar.invalid_count)candles.append(element('circle',{cx:xx,cy:top+plotH-5,r:2,'class':'chart-failed'}));return;}
        const tone=bar.close>bar.open?'up':bar.close<bar.open?'down':'flat',w=Math.max(.8,Math.min(22,plotW/bars.length*.64));
        candles.append(element('line',{x1:xx,x2:xx,y1:y(bar.high),y2:y(bar.low),'class':`wick ${tone}`}));
        candles.append(element('rect',{x:xx-w/2,y:Math.min(y(bar.open),y(bar.close))-.6,width:w,height:Math.max(1.2,Math.abs(y(bar.open)-y(bar.close))),'class':`candle ${tone}${bar.complete?'':' forming'}`}));
      });
      const forecast=element('g',{'class':'estimates'});svg.append(forecast);
      const timeX=time=>left+(Date.parse(time)-Date.parse(data.start))/(Date.parse(data.end)-Date.parse(data.start))*plotW;
      for(const item of estimates){const x1=Math.max(left,timeX(item.based_on_at)),x2=Math.min(width-right,timeX(item.estimated_at));
        const anchor=Date.parse(item.based_on_at),target=Date.parse(item.estimated_at),clipped=Math.max(anchor,Date.parse(data.start));
        const startValue=item.based_on_value_c+(item.value_c-item.based_on_value_c)*(clipped-anchor)/Math.max(1,target-anchor);
        forecast.append(element('path',{d:'M'+x1+','+y(startValue)+'L'+x2+','+y(item.value_c),'class':'chart-estimate'}),element('circle',{cx:x2,cy:y(item.value_c),r:4,'class':'estimate-point'}));}
      this.cross=element('line',{x1:0,x2:0,y1:top,y2:top+plotH,'class':'chart-cross',visibility:'hidden'});svg.append(this.cross);
      $('graph-detail').textContent='봉을 누르거나 좌우 방향키로 첫값·최고·최저·마지막 온도를 확인하세요. 빈 구간은 기록 없음입니다.';
      if(estimates.length)$('graph-detail').textContent+=' 주황 점선·빈 원은 추정값이며 정상 봉·최저/최고 통계에 포함하지 않습니다.';
      if(this.selected>=0)this.detail();
    }
    pick(event){
      if(!this.data?.bars.length||!this.layout)return;const rect=$('trend-chart').getBoundingClientRect(),x=(event.clientX-rect.left)*this.layout.width/rect.width;
      this.selected=Math.max(0,Math.min(this.data.bars.length-1,Math.floor((x-this.layout.left)/this.layout.plotW*this.data.bars.length)));this.detail();
    }
    detail(){
      const bar=this.data?.bars[this.selected];if(!bar)return;
      const x=this.layout.left+(this.selected+.5)*this.layout.plotW/this.data.bars.length;
      this.cross?.setAttribute('x1',x);this.cross?.setAttribute('x2',x);this.cross?.setAttribute('visibility','visible');
      const time=stamp.format(new Date(bar.time));
      const estimates=(this.data.estimates||[]).filter(item=>Date.parse(item.estimated_at)>=Date.parse(bar.time)&&Date.parse(item.estimated_at)<Date.parse(bar.time)+this.minutes*60000);
      $('graph-detail').textContent=bar.count?`${time} · 첫값 ${number(bar.open)} · 최고 ${number(bar.high)} · 최저 ${number(bar.low)} · 마지막 ${number(bar.close)} ℃ · 정상 ${bar.count}건 / 실패 ${bar.invalid_count}건${bar.complete?'':' · 진행 중인 봉'}`:`${time} · ${bar.invalid_count?'정상 판독 없음 / 실패 '+bar.invalid_count+'건':'저장 기록 없음'}`;
      if(estimates.length)$('graph-detail').textContent+=' · 추정 '+estimates.map(item=>'약 '+number(item.value_c)+' ℃').join(', ')+' (실측 아님·정상 통계 제외)';
    }
  }
  globalThis.TC06Graph={Graph};
})();
