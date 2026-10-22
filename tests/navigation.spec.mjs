import {test,expect} from '@playwright/test';

// Synthetic browser responses only; no production temperature writes.
function reading(value=123.4){const at=new Date().toISOString();return{record:{id:'navigation-fixture',status:'ok',value_c:value,captured_at:at,received_at:at},server_now:at};}

test('display menu works with only remote keys and remains visible while focused',async({page})=>{
  await page.route('**/api/latest',route=>route.fulfill({json:reading()}));
  await page.clock.install();await page.goto('/');
  await expect(page.locator('#temperature')).toHaveText('123.4');
  await page.keyboard.press('Enter');await expect(page.locator('#normal-mode')).toBeFocused();
  await page.clock.fastForward(6000);await expect(page.locator('#display-menu')).toBeVisible();
  await expect(page.locator('#normal-mode')).toBeFocused();
  await page.keyboard.press('ArrowRight');await expect(page.locator('#display-settings')).toBeFocused();
  await page.keyboard.press('Enter');await expect(page.locator('body')).toHaveAttribute('data-mode','normal');
  await expect(page.locator('#settings-panel')).toHaveJSProperty('open',true);await expect(page.locator('#volume')).toBeFocused();
});

test('pointer menu still hides after five seconds and arrow navigation wraps through actions',async({page})=>{
  await page.route('**/api/latest',route=>route.fulfill({json:reading()}));
  await page.clock.install();await page.goto('/');
  await expect(page.locator('#temperature')).toHaveText('123.4');
  await page.locator('#temperature').click();await expect(page.locator('#display-menu')).toBeVisible();
  expect(await page.locator('#display-menu').evaluate(menu=>menu.contains(document.activeElement))).toBe(false);
  await page.clock.fastForward(5001);await expect(page.locator('#display-menu')).toBeHidden();
  await page.keyboard.press('ArrowDown');await expect(page.locator('#normal-mode')).toBeFocused();
  await page.keyboard.press('End');await expect(page.locator('#display-refresh')).toBeFocused();
  await page.keyboard.press('ArrowDown');await expect(page.locator('#normal-mode')).toBeFocused();
  await page.keyboard.press('ArrowUp');await expect(page.locator('#display-refresh')).toBeFocused();
  await page.keyboard.press('ArrowLeft');await expect(page.locator('#display-fullscreen')).toBeFocused();
  await page.keyboard.press('Home');await expect(page.locator('#normal-mode')).toBeFocused();
  await page.keyboard.press('Enter');await expect(page.locator('body')).toHaveAttribute('data-mode','normal');
});

test('manual refresh shares an in-flight automatic lookup and restores controls on success or failure',async({page})=>{
  let count=0,hold=false,offline=false,release;
  const pending=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/latest',async route=>{count++;if(hold)await pending;return offline?route.abort():route.fulfill({json:reading(234.5)});});
  await page.goto('/?mode=normal');await expect(page.locator('#temperature')).toHaveText('234.5');expect(count).toBe(1);
  hold=true;await page.evaluate(()=>{window.pendingAutomaticLookup=refresh();});await expect.poll(()=>count).toBe(2);
  await page.locator('#refresh-latest').click();await expect(page.locator('#refresh-latest')).toBeDisabled();
  await expect(page.locator('#display-refresh')).toBeDisabled();await expect(page.locator('#refresh-latest')).toHaveText('재조회 중…');
  await expect(page.locator('#refresh-status')).toContainText('다시 조회');expect(count).toBe(2);
  hold=false;release();await expect(page.locator('#refresh-latest')).toBeEnabled();await expect(page.locator('#display-refresh')).toBeEnabled();
  await expect(page.locator('#refresh-status')).toContainText('재조회 완료');await expect(page.locator('#refresh-status')).toContainText('1분마다');
  offline=true;await page.locator('#refresh-latest').click();await expect(page.locator('#refresh-status')).toContainText('재조회 실패');
  await expect(page.locator('#refresh-latest')).toBeEnabled();await expect(page.locator('#display-refresh')).toBeEnabled();
  await expect(page.locator('#temperature')).toHaveText('234.5');await expect(page.locator('#quality')).toContainText('마지막 정상값');expect(count).toBe(3);
});

test('numeric menu refresh is selectable by remote keys and keeps the reading state policy',async({page})=>{
  let value=123.4,count=0;await page.route('**/api/latest',route=>{count++;return route.fulfill({json:reading(value)});});
  await page.goto('/');await expect(page.locator('#temperature')).toHaveText('123.4');value=345.6;
  await page.keyboard.press('Enter');await page.keyboard.press('End');await expect(page.locator('#display-refresh')).toBeFocused();
  await page.keyboard.press('Enter');await expect(page.locator('#temperature')).toHaveText('345.6');await expect(page.locator('body')).toHaveAttribute('data-mode','display');
  await expect(page.locator('#display-refresh')).toBeEnabled();await expect(page.locator('#display-refresh')).toHaveText('지금 새로고침');
  await expect(page.locator('#refresh-status')).toContainText('재조회 완료');expect(count).toBe(2);
});

test('new controls remain inside phone, narrow desktop and TV viewports',async({page})=>{
  await page.route('**/api/latest',route=>route.fulfill({json:reading()}));
  for(const viewport of [{width:390,height:844},{width:887,height:1200},{width:1920,height:1080}]){
    await page.setViewportSize(viewport);await page.goto('/?mode=normal');
    await expect(page.locator('#temperature')).toHaveText('123.4');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/refresh-normal-${viewport.width}.png`,fullPage:true});
    const refresh=await page.locator('#refresh-latest').boundingBox();
    expect(refresh.x).toBeGreaterThanOrEqual(0);expect(refresh.x+refresh.width).toBeLessThanOrEqual(viewport.width);
    await page.goto('/');await expect(page.locator('#temperature')).toHaveText('123.4');
    await page.keyboard.press('Enter');await page.keyboard.press('End');
    await expect(page.locator('#display-refresh')).toBeFocused();
    const menu=await page.locator('#display-menu').boundingBox();
    expect(menu.x).toBeGreaterThanOrEqual(0);expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(menu.x+menu.width).toBeLessThanOrEqual(viewport.width);expect(menu.y+menu.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/remote-menu-${viewport.width}.png`});
  }
});

test('open remote menu keeps the reading age visible above it without covering its buttons',async({page})=>{
  const at=new Date(),captured=new Date(at-7*60000).toISOString();
  await page.route('**/api/latest',route=>route.fulfill({json:{
    record:null,last_good:{id:'held-menu-fixture',status:'ok',value_c:123.4,captured_at:captured,received_at:captured},server_now:at.toISOString()
  }}));
  for(const viewport of [{width:390,height:844},{width:1920,height:1080}]){
    await page.setViewportSize(viewport);await page.goto('/');
    await expect(page.locator('#display-held')).toBeVisible();
    await page.keyboard.press('Enter');await page.keyboard.press('End');
    await expect(page.locator('#display-refresh')).toBeFocused();
    await expect(page.locator('#display-held')).toBeHidden();
    await expect(page.locator('#display-state')).toBeVisible();
    await expect(page.locator('#display-state')).toContainText('마지막 정상값');
    await page.screenshot({path:`test-results/held-menu-${viewport.width}.png`});
  }
});


