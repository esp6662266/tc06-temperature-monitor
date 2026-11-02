import {test,expect} from '@playwright/test';

async function fixture(page,seconds=60){
  let setting={interval_seconds:seconds,revision:1,updated_at:new Date().toISOString()},reads=0,writes=0,mode='ok';
  await page.route('**/api/latest',route=>{reads++;const at=new Date().toISOString();return route.fulfill({json:{collection_settings:setting,server_now:at,record:{id:'synthetic-collection',status:'ok',value_c:123.4,captured_at:at,received_at:at,record_interval_seconds:seconds,collector_version:'0.7.0'}}});});
  await page.route('**/api/settings',route=>{
    if(route.request().method()==='POST'){
      writes++;
      if(mode==='offline')return route.abort();
      const data=route.request().postDataJSON();
      if(mode==='conflict'||data.revision!==setting.revision)return route.fulfill({status:409,json:{error:'다른 화면에서 설정이 변경됐습니다. 설정을 다시 불러오세요'}});
      setting={interval_seconds:data.interval_seconds,revision:setting.revision+1,updated_at:new Date().toISOString()};
    }
    return route.fulfill({json:setting});
  });
  return {get reads(){return reads;},get writes(){return writes;},set mode(value){mode=value;},set setting(value){setting=value;}};
}
test('homepage saves a custom site interval and separates server save from PC application',async({page})=>{
  const state=await fixture(page);await page.goto('/?mode=normal');
  await page.locator('#collection-panel summary').click();
  await expect(page.locator('#collection-current')).toContainText('1분');
  await expect(page.locator('#collection-applied')).toContainText('1분 간격 적용');
  await page.locator('#collection-seconds').fill('420');await expect(page.locator('#collection-volume')).toContainText('206건');
  await page.locator('#collection-save').click();
  await expect(page.locator('#collection-result')).toContainText('7분 간격을 서버에 저장');
  await expect(page.locator('#collection-result')).toContainText('PC 반영 대기');
  await expect(page.locator('#collection-applied')).toContainText('1분 간격 적용');
  expect(state.writes).toBe(1);
  await page.reload();await page.locator('#collection-panel summary').click();
  await expect(page.locator('#collection-seconds')).toHaveValue('420');
  for(const width of [390,887,1920]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/collection-${width}.png`,fullPage:true});
  }
});
test('conflict and failed saves preserve input and explicit reload recovers the latest revision',async({page})=>{
  const state=await fixture(page);await page.goto('/?mode=normal');await page.locator('#collection-panel summary').click();
  await page.locator('#collection-seconds').fill('300');state.mode='conflict';
  await page.locator('#collection-save').click();await expect(page.locator('#collection-result')).toContainText('다른 화면');
  await expect(page.locator('#collection-seconds')).toHaveValue('300');
  state.mode='offline';await page.locator('#collection-save').click();await expect(page.locator('#collection-result')).toContainText('입력한 값은 유지');
  state.mode='ok';state.setting={interval_seconds:600,revision:2,updated_at:new Date().toISOString()};
  await page.locator('#collection-reload').click();await expect(page.locator('#collection-seconds')).toHaveValue('600');
  await page.locator('#collection-seconds').fill('300');await page.locator('#collection-save').click();
  await expect(page.locator('#collection-result')).toContainText('5분 간격을 서버에 저장');
  await page.locator('#collection-seconds').fill('29');await page.locator('#collection-save').click();
  expect(state.writes).toBe(3);
});
test('five-minute setting bounds automatic and voice reads and keeps original freshness policy',async({page})=>{
  const state=await fixture(page,300);await page.clock.install();await page.goto('/?mode=normal');
  await expect(page.locator('#temperature')).toHaveText('123.4');
  await page.evaluate(()=>{enabled=true;nextAnnouncement=Date.now()+60000;voice.say=async()=>true;});
  await page.clock.fastForward(61000);expect(state.reads).toBe(1);
  await page.clock.fastForward(100000);expect(state.reads).toBe(1);
  await expect(page.locator('#quality')).toContainText('마지막 정상값');
  await page.clock.fastForward(141000);await expect.poll(()=>state.reads).toBe(2);
  await page.locator('#refresh-latest').click();await expect.poll(()=>state.reads).toBe(3);
});
test('legacy records do not claim PC interval was applied',async({page})=>{
  await fixture(page,300);
  await page.route('**/api/latest',route=>route.fulfill({json:{collection_settings:{interval_seconds:300,revision:1},server_now:new Date().toISOString(),record:null}}));
  await page.goto('/?mode=normal');await page.locator('#collection-panel summary').click();
  await expect(page.locator('#collection-applied')).toContainText('PC 적용 미확인');
});
