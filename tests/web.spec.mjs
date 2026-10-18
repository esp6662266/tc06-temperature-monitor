import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Synthetic browser fixtures only; never live PLC data.
function sample(extra={}) {const at=new Date().toISOString();return {record:{id:'fixture',audio_id:'a'.repeat(64),value_c:123.4,status:'ok',captured_at:at,received_at:at,has_audio:true,...extra},server_now:at,max_age_ms:150000,fresh:true};}
test('normal screen retains the last normal reading during stale, invalid and offline states',async({page})=>{
  let body=sample(),offline=false;
  await page.route('**/api/latest',route=>offline?route.abort():route.fulfill({json:body}));
  await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('123.4');await expect(page.locator('#quality')).toHaveText('실제 수신값');
  body=sample({captured_at:new Date(Date.now()-200000).toISOString()});await page.evaluate(()=>refresh());
  await expect(page.locator('#temperature')).toHaveText('123.4');await expect(page.locator('#quality')).toContainText('마지막 정상값');
  body=sample({status:'ocr_failed',value_c:null});await page.evaluate(()=>refresh());await expect(page.locator('#status')).toContainText('판독할 수 없습니다');
  offline=true;await page.evaluate(()=>refresh());await expect(page.locator('#connection')).toHaveText('서버 연결 확인 필요');await expect(page.locator('#temperature')).toHaveText('123.4');
});
test('first visit is a numbers-only display, with remote-accessible normal settings',async({page})=>{
  await page.route('**/api/latest',route=>route.fulfill({json:{record:null,server_now:new Date().toISOString()}}));
  await page.goto('/');await expect(page.locator('#temperature')).toHaveText('38');await expect(page.locator('main > header')).toBeHidden();await expect(page.locator('.unit')).toBeHidden();await expect(page.locator('#display-menu')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight)).toBe(true);
  await page.keyboard.press('Enter');await expect(page.locator('#normal-mode')).toBeVisible();await page.locator('#normal-mode').click();await expect(page.locator('main > header')).toBeVisible();await expect(page).toHaveURL(/mode=normal/);expect(await page.locator('#temperature').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(400);await expect(page.locator('input[type=password]')).toHaveCount(0);
});
test('web number voice pauses for held readings and resumes after recovery',async({page})=>{
  let body=sample();await page.route('**/api/latest',route=>route.fulfill({json:body}));
  await page.clock.install();await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('123.4');
  await page.locator('#speech-start').click();await expect.poll(()=>page.evaluate(()=>voice.lastValue)).toBe(123.4);
  expect(await page.evaluate(()=>voice.lastTokens)).toEqual(['intro','100','2','10','3','point','4','end']);
  body=sample({id:'new-fixture',value_c:124.5});await page.clock.fastForward(60001);await expect.poll(()=>page.evaluate(()=>voice.lastValue)).toBe(124.5);
  body=sample({captured_at:new Date(Date.now()-300000).toISOString()});await page.clock.fastForward(60001);await expect(page.locator('body')).toHaveAttribute('data-state','held');await expect(page.locator('#audio-status')).toContainText('음성 안내 대기');expect(await page.evaluate(()=>voice.lastValue)).toBe(124.5);
  body=sample({id:'recovered-fixture',value_c:125.6});await page.clock.fastForward(60001);await expect.poll(()=>page.evaluate(()=>voice.lastValue)).toBe(125.6);
  await page.locator('#speech-stop').click();await expect(page.locator('#countdown')).toHaveText('꺼짐');expect(await page.evaluate(()=>voice.playing)).toBe(false);
});
test('local HTTP accepts anonymous upload and publicly displays it',async({page,request})=>{
  const timestamp=new Date().toISOString();const record={id:randomUUID(),asset:'TC-06',device_id:'synthetic-http-test',status:'ok',value_c:234.5,captured_at:timestamp,recorded_at:timestamp,source_clock:'12:34:56',confidence:95};
  const response=await request.post('/api/ingest',{data:{record}});expect(response.status()).toBe(200);expect((await response.json()).saved).toBe(true);await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('234.5');const trend=await(await request.get('/api/trend')).json();expect(trend.bars.some(bar=>bar.close===234.5)).toBe(true);
});
test('number voice works without OS speech synthesis or server audio requests',async({page})=>{
  const audioRequests=[];page.on('request',r=>{if(r.url().includes('/api/audio'))audioRequests.push(r.url());});
  await page.addInitScript(()=>{Object.defineProperty(window,'speechSynthesis',{value:undefined,configurable:true});});
  await page.route('**/api/latest',route=>route.fulfill({json:sample({value_c:350.0})}));await page.goto('/?mode=normal');await page.locator('#speech-start').click();
  await expect.poll(()=>page.evaluate(()=>voice.lastValue)).toBe(350);expect(await page.evaluate(()=>voice.lastTokens)).toEqual(['intro','3','100','5','10','end']);
  expect(await page.evaluate(()=>voice.context.state)).toBe('running');expect(audioRequests).toEqual([]);
});
test('TV display preferences persist after reload',async({page})=>{
  await page.goto('/?mode=normal');await page.locator('#color').selectOption('amber');await page.locator('#interval').selectOption('120');await page.locator('#volume').fill('0.4');await page.reload();
  await expect(page.locator('#color')).toHaveValue('amber');await expect(page.locator('#interval')).toHaveValue('120');await expect(page.locator('#volume')).toHaveValue('0.4');await page.keyboard.press('Escape');await page.locator('#display-mode').click();await expect(page.locator('body')).toHaveAttribute('data-mode','display');expect(await page.locator('#temperature').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(255, 230, 0)');
});
test('cached page reloads offline and composes the fixed 38 voice in Web Audio',async({browser})=>{
  const context=await browser.newContext({serviceWorkers:'allow'});const page=await context.newPage();await page.route('**/api/latest',route=>route.fulfill({json:{record:null,last_good:null,server_now:new Date().toISOString()}}));await page.goto('http://127.0.0.1:8766/?mode=normal');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
  await context.setOffline(true);await page.reload();await expect(page.locator('#temperature')).toHaveText('38');await page.locator('#speech-start').click();
  await expect.poll(()=>page.evaluate(()=>voice.lastValue)).toBe(38);expect(await page.evaluate(()=>voice.buffers.size)).toBe(17);
  expect(await page.evaluate(()=>voice.lastTokens)).toEqual(['intro','3','10','8','end']);await expect.poll(()=>page.evaluate(()=>voice.context.currentTime)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>Array.from(voice.buffers.get('intro').getChannelData(0)).some(x=>Math.abs(x)>0.01))).toBe(true);
  await expect(page.locator('#audio-status')).toContainText('기본값 38도');await context.close();
});

test('fullscreen from normal mode leaves only the large temperature',async({page})=>{
  await page.goto('/?mode=normal');await page.locator('#fullscreen').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode','display');await expect(page.locator('main > header')).toBeHidden();await expect(page.locator('#status')).toBeHidden();await expect(page.locator('.metadata')).toBeHidden();await expect(page.locator('.controls')).toBeHidden();await expect(page.locator('.settings')).toBeHidden();await expect(page.locator('.unit')).toBeHidden();await expect(page.locator('#display-menu')).toBeHidden();await expect(page.locator('#temperature')).toBeVisible();
});

test('custom number color updates immediately and survives reload',async({page})=>{
 await page.goto('/?mode=normal');await page.locator('#custom-color').fill('#26a9e0');await expect(page.locator('#color')).toHaveValue('custom');expect(await page.locator('.color-preview').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(38, 169, 224)');
 await page.reload();await expect(page.locator('#custom-color')).toHaveValue('#26a9e0');await page.locator('#display-mode').click();expect(await page.locator('#temperature').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(38, 169, 224)');
});

test('seven contrasting palettes change both display background and number color',async({page})=>{
 await page.goto('/?mode=normal');await expect(page.locator('#palettes button')).toHaveCount(7);await page.locator('[data-palette=yellow]').click();await page.locator('#display-mode').click();
 expect(await page.locator('#temperature').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(0, 0, 0)');expect(await page.locator('#monitor-panel').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(255, 230, 0)');
 await page.keyboard.press('Escape');await page.locator('[data-palette=navy]').click();await page.reload();await expect(page.locator('#color')).toHaveValue('navy');
});

function trendSample(minutes=1,empty=false){
 const end=Math.floor(Date.now()/60000)*60000,start=end-3600000;
 const bars=Array.from({length:60/minutes},(_,i)=>{const value=Math.round((110+Math.sin(i/3)*8)*10)/10;return{time:new Date(start+i*minutes*60000).toISOString(),open:empty?null:value,high:empty?null:value+4,low:empty?null:value-5,close:empty?null:value+2,count:empty?0:minutes,invalid_count:0,complete:true};});
 return{day:new Date(Date.now()+9*3600000).toISOString().slice(0,10),minutes,span:60,timezone:'Asia/Seoul',server_now:new Date().toISOString(),start:new Date(start).toISOString(),end:new Date(end).toISOString(),oldest_day:'2026-01-01',bars,samples:empty?0:60,invalid_samples:0,low:empty?null:Math.min(...bars.map(b=>b.low)),high:empty?null:Math.max(...bars.map(b=>b.high))};
}
test('graph mode keeps current temperature visible while switching 1, 5 and 10-minute candles',async({page})=>{
 const requested=[];await page.route('**/api/latest',route=>route.fulfill({json:sample()}));
 await page.route('**/api/trend**',route=>{const minutes=Number(new URL(route.request().url()).searchParams.get('minutes'));requested.push(minutes);return route.fulfill({json:trendSample(minutes)});});
 await page.goto('/?mode=normal');await page.locator('#graph-mode').click();await expect(page.locator('#graph-screen')).toBeVisible();await expect(page.locator('#graph-temperature')).toHaveText('123.4');await expect(page.locator('.candles .candle')).toHaveCount(60);
 for(const [minutes,count]of[[5,12],[10,6],[1,60]]){await page.getByRole('button',{name:minutes+'분봉',exact:true}).click();await expect(page.locator('.candles .candle')).toHaveCount(count);await expect(page.locator(`[data-minutes="${minutes}"]`)).toHaveAttribute('aria-pressed','true');}
 expect(requested).toEqual([1,5,10,1]);await page.locator('#trend-chart').focus();await page.locator('#trend-chart').press('End');await expect(page.locator('#graph-detail')).toContainText('최고');await expect(page.locator('#graph-detail')).toContainText('마지막');
 await page.locator('#graph-fullscreen').click();await expect(page.locator('body')).toHaveAttribute('data-mode','graph');await expect(page.locator('#graph-temperature')).toBeVisible();await expect(page.locator('#trend-chart')).toBeVisible();
});
test('empty graph never invents a 38-degree history candle',async({page})=>{
 await page.route('**/api/latest',route=>route.fulfill({json:{record:null,server_now:new Date().toISOString()}}));await page.route('**/api/trend**',route=>route.fulfill({json:trendSample(5,true)}));
 await page.goto('/?mode=graph&minutes=5');await expect(page.locator('#graph-temperature')).toHaveText('38');await expect(page.locator('#graph-quality')).toContainText('기본값');await expect(page.locator('#graph-empty')).toBeVisible();await expect(page.locator('.candle')).toHaveCount(0);await expect(page.locator('#graph-low')).toHaveText('—');
});
test('graph refreshes each minute and preserves labelled historical data on connection failure',async({page})=>{
 let offline=false,version=0;await page.route('**/api/latest',route=>offline?route.abort():route.fulfill({json:sample()}));
 await page.route('**/api/trend**',route=>{if(offline)return route.abort();const data=trendSample();data.high=150+version;return route.fulfill({json:data});});
 await page.clock.install();await page.goto('/?mode=graph');await expect(page.locator('#graph-high')).toHaveText('150.0 ℃');version=1;await page.clock.fastForward(60001);await expect(page.locator('#graph-high')).toHaveText('151.0 ℃');
 offline=true;await page.evaluate(()=>Promise.all([refresh(),graph.load(true)]));await expect(page.locator('#graph-temperature')).toHaveText('123.4');await expect(page.locator('#graph-quality')).toContainText('마지막 정상값');await expect(page.locator('#graph-status')).toContainText('마지막 조회');await expect(page.locator('.candle')).toHaveCount(60);
});
test('graph date, range and navigation work without login',async({page})=>{
 await page.route('**/api/trend**',route=>route.fulfill({json:trendSample(10)}));await page.goto('/?mode=graph&minutes=10&span=1440');
 await expect(page.locator('[data-minutes="10"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#graph-span')).toHaveValue('1440');await page.locator('#graph-span').selectOption('60');await page.locator('#graph-live').click();
 await page.locator('#graph-to-display').click();await expect(page.locator('body')).toHaveAttribute('data-mode','display');await page.keyboard.press('Enter');await page.locator('#display-to-graph').click();await expect(page.locator('body')).toHaveAttribute('data-mode','graph');await page.locator('#graph-to-normal').click();await expect(page.locator('body')).toHaveAttribute('data-mode','normal');await expect(page.locator('input[type=password]')).toHaveCount(0);
});
test('graph automatically expands its temperature axis to include 900 degrees',async({page})=>{
 const data=trendSample(10);data.bars[0]={...data.bars[0],open:850,high:900,low:800,close:890};data.high=900;
 await page.route('**/api/latest',route=>route.fulfill({json:sample({value_c:900})}));await page.route('**/api/trend**',route=>route.fulfill({json:data}));await page.goto('/?mode=graph&minutes=10');
 await expect(page.locator('#graph-temperature')).toHaveText('900.0');await expect(page.locator('#graph-high')).toHaveText('900.0 ℃');
 const ticks=await page.locator('.chart-grid text').allTextContents();expect(Math.max(...ticks.map(Number).filter(Number.isFinite))).toBeGreaterThanOrEqual(900);expect(Number(await page.locator('.wick').first().getAttribute('y1'))).toBeGreaterThanOrEqual(30);
});


test('new viewers recover the server last normal value and its original age in all modes',async({page})=>{
 const now=Date.now(),captured=new Date(now-7*60000).toISOString();await page.clock.install({time:now});
 const body={...sample({status:'ocr_failed',value_c:null}),server_now:new Date(now).toISOString(),last_good:sample({value_c:906.7,captured_at:captured}).record};
 await page.route('**/api/latest',route=>route.fulfill({json:body}));await page.route('**/api/trend**',route=>route.fulfill({json:trendSample(1,true)}));
 await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('906.7');await expect(page.locator('#quality')).toHaveText('마지막 정상값 · 7분 전');
 await expect(page.locator('#captured')).toHaveText(await page.evaluate(at=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(at)),captured));
 await page.locator('#display-mode').click();await expect(page.locator('#display-held')).toBeVisible();await expect(page.locator('#display-held')).toHaveText('마지막 정상값 · 7분 전');
 await page.keyboard.press('Enter');await page.locator('#display-to-graph').click();await expect(page.locator('#graph-temperature')).toHaveText('906.7');await expect(page.locator('#graph-reading-label')).toContainText('마지막 정상 온도');await expect(page.locator('.candle')).toHaveCount(0);
});
test('held age advances without a new measurement, then disappears on recovery',async({page})=>{
 const now=Date.now();let serverNow=now,normal=false;const saved=sample({value_c:999.9,captured_at:new Date(now-3*60000).toISOString()}).record;
 await page.clock.install({time:now});await page.route('**/api/latest',route=>route.fulfill({json:{record:normal?{...saved,value_c:1000,captured_at:new Date(serverNow).toISOString()}:null,last_good:saved,server_now:new Date(serverNow).toISOString()}}));
 await page.goto('/?mode=display');await expect(page.locator('#display-held')).toHaveText('마지막 정상값 · 3분 전');
 serverNow+=60000;await page.clock.fastForward(60000);await expect(page.locator('#display-held')).toHaveText('마지막 정상값 · 4분 전');
 normal=true;await page.evaluate(()=>refresh());await expect(page.locator('#temperature')).toHaveText('1000.0');await expect(page.locator('#display-held')).toBeHidden();await expect(page.locator('body')).toHaveAttribute('data-state','good');
});
test('cached last normal value survives reload and API outage without changing capture time',async({page})=>{
 const now=Date.now(),captured=new Date(now-5*60000).toISOString();let offline=false;
 await page.clock.install({time:now});await page.route('**/api/latest',route=>offline?route.abort():route.fulfill({json:{record:null,last_good:sample({value_c:700.1,captured_at:captured}).record,server_now:new Date(now).toISOString()}}));
 await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('700.1');offline=true;await page.reload();
 await expect(page.locator('#quality')).toHaveText('마지막 정상값 · 5분 전');await expect(page.locator('#temperature')).toHaveText('700.1');expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('tc06-last-good-v1')).captured_at)).toBe(captured);
});
test('expired and future cache entries never become held temperatures',async({page})=>{
 const now=Date.now(),old=sample({captured_at:new Date(now-31*86400000).toISOString()}).record;
 await page.addInitScript(record=>localStorage.setItem('tc06-last-good-v1',JSON.stringify(location.search.includes('future')?{...record,captured_at:new Date(Date.now()+86400000).toISOString()}:record)),old);
 await page.route('**/api/latest',route=>route.fulfill({json:{record:null,last_good:old,server_now:new Date(now).toISOString()}}));
 await page.goto('/?mode=display');await expect(page.locator('#temperature')).toHaveText('38');await expect(page.locator('#display-held')).toBeHidden();
 await page.goto('/?mode=display&future=1');await expect(page.locator('#temperature')).toHaveText('38');
});
test('held numeric display keeps both number and age within TV and narrow screens',async({page})=>{
 const now=Date.now();await page.route('**/api/latest',route=>route.fulfill({json:{record:null,last_good:sample({value_c:1000.9,captured_at:new Date(now-125*60000).toISOString()}).record,server_now:new Date(now).toISOString()}}));
 await page.goto('/?mode=display');for(const size of [{width:1920,height:1080},{width:390,height:844}]){
   await page.setViewportSize(size);await expect(page.locator('#display-held')).toBeVisible();await expect(page.locator('#temperature')).toHaveText('1000.9');
   await expect.poll(async()=>{const box=await page.locator('#temperature').boundingBox();return box.x>=0&&box.x+box.width<=size.width;}).toBe(true);const value=await page.locator('#temperature').boundingBox(),label=await page.locator('#display-held').boundingBox();expect(value.x).toBeGreaterThanOrEqual(0);expect(value.y).toBeGreaterThanOrEqual(0);expect(value.x+value.width).toBeLessThanOrEqual(size.width);expect(value.y+value.height).toBeLessThanOrEqual(label.y);expect(label.y+label.height).toBeLessThanOrEqual(size.height);
 }
});

// Synthetic forecast fixtures. No requests write these values to production.
function forecastSample(now=Date.now(),age=60000){
 const base=new Date(now-age).toISOString(),body=sample({id:'failed-forecast',status:'ocr_failed',value_c:null,captured_at:new Date(now-1000).toISOString()});
 body.server_now=new Date(now).toISOString();body.last_good=sample({id:'forecast-basis',value_c:600,captured_at:base,received_at:base}).record;
 body.estimate={estimated:true,value_c:605,estimated_at:new Date(now).toISOString(),based_on_at:base,based_on_value_c:600,last_normal_id:'forecast-basis',expires_at:new Date(now-age+120000).toISOString(),sample_count:3,slope_c_per_minute:5};return body;
}
test('short forecasts are explicitly labelled in normal, numeric and graph screens',async({page})=>{
 await page.route('**/api/latest',r=>r.fulfill({json:forecastSample()}));await page.route('**/api/trend**',r=>r.fulfill({json:trendSample(1,true)}));
 await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('≈605.0');await expect(page.locator('#quality')).toContainText('추정값');await expect(page.locator('#status')).toContainText('최대 2분');
 await page.locator('#display-mode').click();await expect(page.locator('#display-held')).toBeVisible();await expect(page.locator('#display-held')).toContainText('추정값 · 마지막 실측');await page.keyboard.press('Enter');await page.locator('#display-to-graph').click();await expect(page.locator('#graph-temperature')).toHaveText('≈605.0');await expect(page.locator('#graph-reading-label')).toContainText('추정 온도');
});
test('forecasts expire at two minutes without waiting for another server response',async({page})=>{
 const now=Date.now(),body=forecastSample(now,90000);await page.clock.install({time:now});await page.route('**/api/latest',r=>r.fulfill({json:body}));await page.goto('/?mode=display');await expect(page.locator('#temperature')).toHaveText('≈605.0');await page.clock.fastForward(31000);await expect(page.locator('#temperature')).toHaveText('600.0');await expect(page.locator('#display-held')).toContainText('마지막 정상값');
});
test('API failure immediately drops forecasts and reload keeps only the real last normal',async({page})=>{
 let offline=false;await page.route('**/api/latest',r=>offline?r.abort():r.fulfill({json:forecastSample()}));await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('≈605.0');
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('tc06-last-good-v1')).value_c)).toBe(600);offline=true;await page.evaluate(()=>refresh());await expect(page.locator('#temperature')).toHaveText('600.0');await page.reload();await expect(page.locator('#temperature')).toHaveText('600.0');await expect(page.locator('#quality')).toContainText('마지막 정상값');
});
test('forecasts never use the current-temperature voice and normal readings resume it',async({page})=>{
 let body=forecastSample();await page.route('**/api/latest',r=>r.fulfill({json:body}));await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('≈605.0');
 await page.evaluate(()=>{window.syntheticVoiceCalls=0;voice.say=async()=>{window.syntheticVoiceCalls++;return true;};});await page.locator('#speech-start').click();await expect(page.locator('#audio-status')).toContainText('음성 안내 대기');expect(await page.evaluate(()=>window.syntheticVoiceCalls)).toBe(0);
 body=sample({id:'recovered-forecast',value_c:606});await page.evaluate(()=>announce());await expect(page.locator('#temperature')).toHaveText('606.0');expect(await page.evaluate(()=>window.syntheticVoiceCalls)).toBe(1);await expect(page.locator('body')).toHaveAttribute('data-state','good');
});
test('forecast graph uses dashed overlays and excludes estimates from candles and measured extrema',async({page})=>{
 const data=trendSample();const last=data.bars.at(-1);data.bars[data.bars.length-1]={...last,open:null,high:null,low:null,close:null,count:0,invalid_count:1};data.samples=59;data.invalid_samples=1;
 data.estimates=[{estimated:true,value_c:905,based_on_value_c:600,based_on_at:data.bars.at(-2).time,estimated_at:last.time}];
 await page.route('**/api/latest',r=>r.fulfill({json:forecastSample()}));await page.route('**/api/trend**',r=>r.fulfill({json:data}));await page.goto('/?mode=graph');await expect(page.locator('.candle')).toHaveCount(59);await expect(page.locator('.chart-estimate')).toHaveCount(1);await expect(page.locator('.estimate-point')).toHaveCount(1);await expect(page.locator('#graph-high')).toHaveText(data.high.toFixed(1)+' ℃');
 expect(await page.locator('.chart-estimate').evaluate(el=>getComputedStyle(el).strokeDasharray)).not.toBe('none');await page.locator('#trend-chart').focus();await page.locator('#trend-chart').press('End');await expect(page.locator('#graph-detail')).toContainText('추정 약 905.0');await expect(page.locator('#graph-detail')).toContainText('정상 통계 제외');
 const ticks=await page.locator('.chart-grid text').allTextContents();expect(Math.max(...ticks.map(Number).filter(Number.isFinite))).toBeGreaterThanOrEqual(905);
});
test('estimated thousands and their disclosure fit both desktop and narrow numeric displays',async({page})=>{
 const body=forecastSample();body.estimate.value_c=1004.9;await page.route('**/api/latest',r=>r.fulfill({json:body}));await page.goto('/?mode=display');
 for(const size of [{width:1920,height:1080},{width:390,height:844}]){await page.setViewportSize(size);await expect(page.locator('#temperature')).toHaveText('≈1004.9');await expect.poll(async()=>{const a=await page.locator('#temperature').boundingBox(),b=await page.locator('#display-held').boundingBox();return a.x>=0&&a.x+a.width<=size.width&&a.y>=0&&a.y+a.height<=b.y&&b.y+b.height<=size.height;}).toBe(true);}
});
test('a forecast-only window remains visible while measured extrema stay empty',async({page})=>{
 const data=trendSample(1,true),at=data.bars[0].time,basis=new Date(Date.parse(at)-60000).toISOString();data.estimates=[{estimated:true,value_c:605,based_on_value_c:600,based_on_at:basis,estimated_at:at}];
 await page.route('**/api/latest',r=>r.fulfill({json:forecastSample()}));await page.route('**/api/trend**',r=>r.fulfill({json:data}));await page.goto('/?mode=graph');await expect(page.locator('#graph-empty')).toBeHidden();await expect(page.locator('.chart-estimate')).toHaveCount(1);await expect(page.locator('.candle')).toHaveCount(0);await expect(page.locator('#graph-low')).toHaveText('—');await expect(page.locator('#graph-high')).toHaveText('—');
 const coordinates=await page.locator('.estimate-point').evaluate(el=>({y:Number(el.getAttribute('cy')),height:el.ownerSVGElement.viewBox.baseVal.height}));expect(coordinates.y).toBeGreaterThanOrEqual(30);expect(coordinates.y).toBeLessThan(coordinates.height-44);
});

test('update admin requires authentication and explicit apply; tokens are never persisted',async({page})=>{
 const adminToken='synthetic-admin-token-'.padEnd(43,'x');let commands=0;
 const device={device_id:'synthetic-pc',version:'0.6.0',status:'idle',online:true,seen_at:Date.now(),available:{version:'0.6.1'},command:null};
 await page.route('**/api/updates/admin/**',async route=>{
  expect(route.request().headers().authorization).toBe('Bearer '+adminToken);
  const action=new URL(route.request().url()).pathname.split('/').at(-1);
  if(action==='nonce')return route.fulfill({json:{nonce:'a'.repeat(48)}});
  if(action==='command'){commands++;expect(route.request().method()).toBe('POST');expect(route.request().postDataJSON()).toEqual({device_id:'synthetic-pc'});return route.fulfill({json:{command:{id:'synthetic'}}});}
  return route.fulfill({json:{devices:[device]}});
 });
 await page.goto('/updates.html');await expect(page.locator('#workspace')).toBeHidden();
 await page.locator('#admin-token').fill(adminToken);await page.getByRole('button',{name:'관리자 연결',exact:true}).click();
 await expect(page.locator('#devices')).toContainText('0.6.1');expect(commands).toBe(0);
 await page.getByRole('button',{name:'업데이트 적용',exact:true}).click();expect(commands).toBe(0);
 await expect(page.locator('#confirmation')).toBeVisible();await page.locator('#apply').click();await expect.poll(()=>commands).toBe(1);
 expect(await page.evaluate(()=>localStorage.length)).toBe(0);expect(await page.evaluate(()=>sessionStorage.length)).toBe(0);
 await page.locator('#logout').click();await expect(page.locator('#workspace')).toBeHidden();await expect(page.locator('#admin-token')).toHaveValue('');
});

test('update screen fits a phone and disables apply for offline or same-version agents',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.route('**/api/updates/admin/**',route=>route.fulfill({json:{devices:[{device_id:'synthetic-long-device-name-123456789',version:'0.6.0',status:'idle',online:false,seen_at:0,available:{version:'0.6.1'}}]}}));
 await page.goto('/updates.html');await page.locator('#admin-token').fill('A'.repeat(43));await page.getByRole('button',{name:'관리자 연결',exact:true}).click();
 await expect(page.getByRole('button',{name:'업데이트 적용',exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/update-mobile.png',fullPage:true});
});
