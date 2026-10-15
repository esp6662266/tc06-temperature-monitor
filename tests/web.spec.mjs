import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Synthetic browser fixtures only; never live PLC data.
function sample(extra={}) {const at=new Date().toISOString();return {record:{id:'fixture',audio_id:'a'.repeat(64),value_c:123.4,status:'ok',captured_at:at,received_at:at,has_audio:true,...extra},server_now:at,max_age_ms:150000,fresh:true};}
test('normal screen distinguishes received readings from all 38-degree fallback states',async({page})=>{
  let body=sample(),offline=false;
  await page.route('**/api/latest',route=>offline?route.abort():route.fulfill({json:body}));
  await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('123.4');await expect(page.locator('#quality')).toHaveText('실제 수신값');
  body=sample({captured_at:new Date(Date.now()-200000).toISOString()});await page.evaluate(()=>refresh());
  await expect(page.locator('#temperature')).toHaveText('38');await expect(page.locator('#quality')).toHaveText('기본값 · 38도');
  body=sample({status:'ocr_failed',value_c:null});await page.evaluate(()=>refresh());await expect(page.locator('#status')).toContainText('판독할 수 없습니다');
  offline=true;await page.evaluate(()=>refresh());await expect(page.locator('#connection')).toHaveText('서버 연결 확인 필요');await expect(page.locator('#temperature')).toHaveText('38');
});
test('first visit is a numbers-only display, with remote-accessible normal settings',async({page})=>{
  await page.route('**/api/latest',route=>route.fulfill({json:{record:null,server_now:new Date().toISOString()}}));
  await page.goto('/');await expect(page.locator('#temperature')).toHaveText('38');await expect(page.locator('header')).toBeHidden();await expect(page.locator('.unit')).toBeHidden();await expect(page.locator('#display-menu')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight)).toBe(true);
  await page.keyboard.press('Enter');await expect(page.locator('#normal-mode')).toBeVisible();await page.locator('#normal-mode').click();await expect(page.locator('header')).toBeVisible();await expect(page).toHaveURL(/mode=normal/);expect(await page.locator('#temperature').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(400);await expect(page.locator('input[type=password]')).toHaveCount(0);
});
test('voice selects the latest reading every minute then fixed 38 audio when stale',async({page})=>{
  let body=sample();await page.addInitScript(()=>{HTMLMediaElement.prototype.play=function(){return Promise.resolve();};HTMLMediaElement.prototype.pause=function(){};});
  await page.route('**/api/latest',route=>route.fulfill({json:body}));await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('123.4');
  await page.clock.install();await page.locator('#speech-start').click();await expect(page.locator('#audio')).toHaveAttribute('src','/api/audio?id='+'a'.repeat(64));
  body=sample({id:'new-fixture',audio_id:'b'.repeat(64),value_c:124.5});await page.clock.fastForward(60001);await expect(page.locator('#audio')).toHaveAttribute('src','/api/audio?id='+'b'.repeat(64));
  body=sample({captured_at:new Date(Date.now()-300000).toISOString()});await page.clock.fastForward(60001);await expect(page.locator('#audio')).toHaveAttribute('src',/^(blob:|\/audio\/fallback-38.mp3)/);await expect(page.locator('#audio-status')).toContainText('기본값 38도');
  await page.locator('#speech-stop').click();await expect(page.locator('#countdown')).toHaveText('꺼짐');
});
test('local HTTP accepts anonymous upload and publicly displays it',async({page,request})=>{
  const timestamp=new Date().toISOString();const record={id:randomUUID(),asset:'TC-06',device_id:'synthetic-http-test',status:'ok',value_c:234.5,captured_at:timestamp,recorded_at:timestamp,source_clock:'12:34:56',confidence:95};
  const response=await request.post('/api/ingest',{data:{record}});expect(response.status()).toBe(200);expect((await response.json()).saved).toBe(true);await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('234.5');
});
test('cached fixed audio can be selected after API failure',async({page})=>{
  let offline=false;await page.addInitScript(()=>{HTMLMediaElement.prototype.play=function(){return Promise.resolve();};HTMLMediaElement.prototype.pause=function(){};});
  await page.route('**/api/latest',route=>offline?route.abort():route.fulfill({json:sample()}));await page.goto('/?mode=normal');await expect.poll(()=>page.evaluate(()=>Boolean(fallbackURL))).toBe(true);
  await page.locator('#speech-start').click();await expect.poll(()=>page.evaluate(()=>announcing)).toBe(false);offline=true;await page.evaluate(()=>announce());await expect(page.locator('#audio')).toHaveAttribute('src',/^blob:/);await expect(page.locator('#temperature')).toHaveText('38');
});
test('TV display preferences persist after reload',async({page})=>{
  await page.goto('/?mode=normal');await page.locator('#color').selectOption('amber');await page.locator('#interval').selectOption('120');await page.locator('#volume').fill('0.4');await page.reload();
  await expect(page.locator('#color')).toHaveValue('amber');await expect(page.locator('#interval')).toHaveValue('120');await expect(page.locator('#volume')).toHaveValue('0.4');await page.keyboard.press('Escape');await page.locator('#display-mode').click();await expect(page.locator('body')).toHaveAttribute('data-mode','display');expect(await page.locator('#temperature').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(255, 230, 0)');
});
test('cached page reloads offline at 38 and fixed female audio actually decodes and plays',async({browser})=>{
  const context=await browser.newContext({serviceWorkers:'allow'});const page=await context.newPage();await page.goto('http://127.0.0.1:8766/?mode=normal');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
  await context.setOffline(true);await page.reload();await expect(page.locator('#temperature')).toHaveText('38');await expect.poll(()=>page.evaluate(()=>Boolean(fallbackURL))).toBe(true);await page.locator('#speech-start').click();
  await expect.poll(()=>page.evaluate(()=>{const a=document.getElementById('audio');return a.currentTime>0&&!a.error;})).toBe(true);await expect(page.locator('#audio-status')).toContainText('기본값 38도');
  await context.close();
});

test('fullscreen from normal mode leaves only the large temperature',async({page})=>{
  await page.goto('/?mode=normal');await page.locator('#fullscreen').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode','display');await expect(page.locator('header')).toBeHidden();await expect(page.locator('#status')).toBeHidden();await expect(page.locator('.metadata')).toBeHidden();await expect(page.locator('.controls')).toBeHidden();await expect(page.locator('.settings')).toBeHidden();await expect(page.locator('.unit')).toBeHidden();await expect(page.locator('#display-menu')).toBeHidden();await expect(page.locator('#temperature')).toBeVisible();
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
