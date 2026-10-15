import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// All values below are synthetic browser-test fixtures, never live PLC data.
function sample(extra={}) {
  const at=new Date().toISOString();
  return {record:{id:'fixture',audio_id:'a'.repeat(64),value_c:123.4,status:'ok',captured_at:at,received_at:at,has_audio:true,...extra},server_now:at,max_age_ms:150000,fresh:true};
}
test('valid, stale, failure and connection states never mislabel old values as current',async({page})=>{
  let body=sample(), offline=false;
  await page.route('**/api/latest',route=>offline?route.abort():route.fulfill({json:body}));
  await page.goto('/');
  await expect(page.locator('#temperature')).toHaveText('123.4');
  body=sample({captured_at:new Date(Date.now()-200000).toISOString()});
  await page.evaluate(()=>refresh());
  await expect(page.locator('#temperature')).toHaveText('—');
  await expect(page.locator('#quality')).toHaveText('갱신 끊김');
  body=sample({status:'ocr_failed',value_c:null});
  await page.evaluate(()=>refresh());
  await expect(page.locator('#status')).toContainText('판독할 수 없습니다');
  offline=true;
  await page.evaluate(()=>refresh());
  await expect(page.locator('#connection')).toHaveText('서버 연결 확인 필요');
});
test('public page opens without any login or key fields',async({page})=>{
  await page.route('**/api/latest',route=>route.fulfill({json:{record:null,server_now:new Date().toISOString()}}));
  await page.goto('/');
  await expect(page.locator('#monitor-panel')).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.locator('#temperature')).toHaveText('—');
});
test('announcement uses latest record every minute and stale warning after expiry',async({page})=>{
  let body=sample(), requested=[];
  await page.addInitScript(()=>{
    HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
    HTMLMediaElement.prototype.pause=function(){};
  });
  await page.route('**/api/latest',route=>route.fulfill({json:body}));
  await page.goto('/');
  await expect(page.locator('#temperature')).toHaveText('123.4');
  await page.clock.install();
  await page.locator('#speech-start').click();
  await expect(page.locator('#audio')).toHaveAttribute('src','/api/audio?id='+'a'.repeat(64));
  body=sample({id:'new-fixture',audio_id:'b'.repeat(64),value_c:124.5});
  await page.clock.fastForward(60001);
  await expect(page.locator('#audio')).toHaveAttribute('src','/api/audio?id='+'b'.repeat(64));
  body=sample({captured_at:new Date(Date.now()-300000).toISOString()});
  await page.clock.fastForward(60001);
  await expect(page.locator('#audio')).toHaveAttribute('src','/api/audio?id=notice-stale');
  await page.locator('#speech-stop').click();
  await expect(page.locator('#countdown')).toHaveText('꺼짐');
});
test('real local HTTP bridge accepts anonymous upload and displays it publicly',async({page,request})=>{
  const timestamp=new Date().toISOString();
  const record={id:randomUUID(),asset:'TC-06',device_id:'synthetic-http-test',status:'ok',value_c:234.5,
    captured_at:timestamp,recorded_at:timestamp,source_clock:'12:34:56',confidence:95};
  const response=await request.post('/api/ingest',{data:{record}});
  expect(response.status()).toBe(200);
  expect((await response.json()).saved).toBe(true);
  await page.goto('/');
  await expect(page.locator('#temperature')).toHaveText('234.5');
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});
test('cached warning audio remains available after server connection is lost',async({page})=>{
  let offline=false;
  await page.addInitScript(()=>{
    HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
    HTMLMediaElement.prototype.pause=function(){};
  });
  const wav=Buffer.alloc(100);wav.write('RIFF');wav.write('WAVE',8);
  await page.route('**/api/audio?id=notice-stale',route=>route.fulfill({body:wav,contentType:'audio/wav'}));
  await page.route('**/api/latest',route=>offline?route.abort():route.fulfill({json:sample()}));
  await page.goto('/');
  await expect.poll(()=>page.evaluate(()=>Boolean(noticeURL))).toBe(true);
  await page.locator('#speech-start').click();
  await expect(page.locator('#audio')).toHaveAttribute('src','/api/audio?id='+'a'.repeat(64));
  await expect.poll(()=>page.evaluate(()=>announcing)).toBe(false);
  offline=true;
  await page.evaluate(()=>announce());
  await expect(page.locator('#audio')).toHaveAttribute('src',/^blob:/);
  await expect(page.locator('#temperature')).toHaveText('—');
});
