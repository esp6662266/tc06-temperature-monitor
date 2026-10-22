import { test, expect } from '@playwright/test';

// Synthetic browser responses only; these tests never upload temperature records.
async function mockReadings(page) {
  const requests={latest:0,trend:[]};
  await page.route('**/api/latest',route=>{
    requests.latest++;
    const at=new Date().toISOString();
    return route.fulfill({json:{record:{id:'graph-settings-fixture',status:'ok',value_c:123.4,captured_at:at,received_at:at},server_now:at}});
  });
  await page.route('**/api/trend**',route=>{
    const query=new URL(route.request().url()).searchParams;
    const minutes=Number(query.get('minutes')),span=Number(query.get('span'));
    requests.trend.push({minutes,span});
    const end=Date.now(),start=end-minutes*60000;
    return route.fulfill({json:{
      day:query.get('day'),minutes,span,server_now:new Date(end).toISOString(),
      start:new Date(start).toISOString(),end:new Date(end).toISOString(),oldest_day:'2026-01-01',
      bars:[{time:new Date(start).toISOString(),open:123.4,high:124,low:123,close:123.4,count:1,invalid_count:0,complete:true}],
      samples:1,invalid_samples:0,low:123,high:124,estimates:[],
    }});
  });
  return requests;
}

async function seedSettings(page,graph,view) {
  await page.addInitScript(({graph,view})=>{
    localStorage.setItem('tc06-graph-v1',graph);
    localStorage.setItem('tc06-graph-view-v1',view);
  },{graph,view});
}

async function expectInitialized(page,mode,requests) {
  const previous=requests.latest;
  await page.goto('/?mode='+mode);
  await expect(page.locator('body')).toHaveAttribute('data-mode',mode);
  await expect(page.locator(mode==='graph'?'#graph-temperature':'#temperature')).toHaveText('123.4');
  await expect(page.locator('body')).toHaveAttribute('data-state','good');
  expect(requests.latest).toBe(previous+1);
  if(mode==='graph'){
    await expect(page.locator('.candles .candle')).toHaveCount(1);
    await expect(page.locator('#graph-status')).toContainText('실측 1건');
  }
}

for(const [name,raw] of [
  ['null','null'],['boolean','true'],['number','42'],['string','"invalid"'],
  ['array','[5,1440]'],['malformed JSON','{invalid'],
  ['invalid fields','{"minutes":7,"span":-1,"axis":"fixed","reference":true}'],
]){
  test(`${name} graph preferences cannot block any screen's first API reading`,async({page})=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await seedSettings(page,raw,raw);
    const requests=await mockReadings(page);
    for(const mode of ['display','normal','graph']){
      await expectInitialized(page,mode,requests);
      await expect(page.locator('[data-minutes="1"]')).toHaveAttribute('aria-pressed','true');
      await expect(page.locator('#graph-span')).toHaveValue('360');
      await expect(page.locator('#axis-mode')).toHaveValue('auto');
      await expect(page.locator('#reference-enabled')).not.toBeChecked();
    }
    expect(requests.trend).toEqual([{minutes:1,span:360}]);
    expect(errors).toEqual([]);
  });
}

test('valid saved timeframe, fixed axis and reference settings still initialize every screen',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await seedSettings(page,JSON.stringify({minutes:5,span:60}),JSON.stringify({axis:'fixed',min:100,max:200,reference:true,target:150,low:120,high:180}));
  const requests=await mockReadings(page);
  for(const mode of ['display','normal','graph']){
    await expectInitialized(page,mode,requests);
    await expect(page.locator('[data-minutes="5"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('#graph-span')).toHaveValue('60');
    await expect(page.locator('#axis-mode')).toHaveValue('fixed');
    await expect(page.locator('#axis-min')).toHaveValue('100');
    await expect(page.locator('#axis-max')).toHaveValue('200');
    await expect(page.locator('#reference-enabled')).toBeChecked();
    await expect(page.locator('#target-value')).toHaveValue('150');
    await expect(page.locator('#reference-min')).toHaveValue('120');
    await expect(page.locator('#reference-max')).toHaveValue('180');
  }
  await expect(page.locator('.chart-target')).toHaveCount(1);
  expect(requests.trend).toEqual([{minutes:5,span:60}]);
  expect(errors).toEqual([]);
});

test('URL timeframe continues to take precedence over saved preferences',async({page})=>{
  await seedSettings(page,JSON.stringify({minutes:5,span:60}),'null');
  const requests=await mockReadings(page);
  await page.goto('/?mode=graph&minutes=10&span=1440');
  await expect(page.locator('#graph-temperature')).toHaveText('123.4');
  await expect(page.locator('.candles .candle')).toHaveCount(1);
  await expect(page.locator('[data-minutes="10"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#graph-span')).toHaveValue('1440');
  await expect(page.locator('#axis-mode')).toHaveValue('auto');
  expect(requests.trend).toEqual([{minutes:10,span:1440}]);
});
