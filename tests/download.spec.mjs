import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Synthetic local exports only; production history is never written by these tests.
const now = new Date('2026-10-22T03:00:00Z');
async function dashboard(page) {
  await page.clock.install({time:now});
  await page.route('**/api/latest',route=>route.fulfill({json:{
    record:{id:'download-fixture',status:'ok',value_c:123.4,captured_at:now.toISOString(),received_at:now.toISOString()},
    server_now:now.toISOString()
  }}));
  await page.goto('/?mode=normal');
  await expect(page.locator('#temperature')).toHaveText('123.4');
  await page.locator('#history-panel summary').click();
}

test('CSV downloads an attachment without leaving the monitor and uses KST retention bounds',async({page})=>{
  const csv='\uFEFFid,value_c\r\n"synthetic",123.4';
  await page.route('**/api/history**',route=>route.fulfill({body:csv,contentType:'text/csv; charset=utf-8'}));
  await dashboard(page);
  await expect(page.locator('#history-day')).toHaveValue('2026-10-22');
  await expect(page.locator('#history-day')).toHaveAttribute('min','2026-09-23');
  await expect(page.locator('#history-day')).toHaveAttribute('max','2026-10-22');
  const pending=page.waitForEvent('download');
  await page.locator('#download').click();
  const download=await pending;
  expect(download.suggestedFilename()).toBe('TC06-2026-10-22-KST.csv');
  expect(await readFile(await download.path(),'utf8')).toBe(csv);
  await expect(page).toHaveURL(/mode=normal/);
  await expect(page.locator('#temperature')).toHaveText('123.4');
  await expect(page.locator('#history-status')).toContainText('다운로드를 시작');
  await expect(page.locator('#download')).toBeEnabled();
});

test('CSV server error stays inline and allows a successful retry',async({page})=>{
  let fail=true;
  await page.route('**/api/history**',route=>fail?route.fulfill({status:503,json:{error:'서버 저장소 조회 실패'}}):route.fulfill({contentType:'text/csv',body:'id,value_c\r\n'}));
  await dashboard(page);await page.locator('#download').click();
  await expect(page.locator('#history-status')).toContainText('서버 저장소 조회 실패');
  await expect(page.locator('#history-status')).toHaveAttribute('data-state','error');
  await expect(page.locator('#download')).toBeEnabled();
  await expect(page).toHaveURL(/mode=normal/);
  await expect(page.locator('#temperature')).toHaveText('123.4');
  fail=false;const pending=page.waitForEvent('download');await page.locator('#download').click();await pending;
  await expect(page.locator('#history-status')).toContainText('다운로드를 시작');
});

test('CSV empty, future and expired dates do not issue a history request',async({page})=>{
  let requests=0;await page.route('**/api/history**',route=>{requests++;return route.abort();});
  await dashboard(page);
  for(const date of ['', '2026-10-23', '2026-09-22']){
    await page.locator('#history-day').fill(date);await page.locator('#download').click();
    await expect(page.locator('#history-status')).toHaveAttribute('data-state','error');
  }
  expect(requests).toBe(0);
  await expect(page).toHaveURL(/mode=normal/);
});

test('CSV network failure or a non-CSV success response cannot replace the dashboard',async({page})=>{
  let networkFailure=true;
  await page.route('**/api/history**',route=>networkFailure?route.abort():route.fulfill({body:'<html>offline gateway</html>',contentType:'text/html'}));
  await dashboard(page);await page.locator('#download').click();
  await expect(page.locator('#history-status')).toHaveAttribute('data-state','error');
  await expect(page.locator('#download')).toBeEnabled();
  networkFailure=false;await page.locator('#download').click();
  await expect(page.locator('#history-status')).toContainText('CSV');
  await expect(page).toHaveURL(/mode=normal/);
  await expect(page.locator('#temperature')).toHaveText('123.4');
});

test('CSV pending requests are not duplicated and time out with retry available',async({page})=>{
  let requests=0;
  await page.route('**/api/history**',route=>{requests++;});
  await dashboard(page);await page.locator('#download').click();
  await expect(page.locator('#download')).toBeDisabled();
  await expect(page.locator('#history-status')).toContainText('불러오는 중');
  await page.clock.fastForward(20001);
  await expect(page.locator('#download')).toBeEnabled();
  await expect(page.locator('#history-status')).toHaveAttribute('data-state','error');
  expect(requests).toBe(1);await expect(page).toHaveURL(/mode=normal/);
});

test('CSV default date follows server time at KST midnight while an explicit selection is preserved',async({page})=>{
  await page.clock.install({time:new Date('2026-10-22T15:01:00Z')});
  let serverNow='2026-10-22T14:59:00Z';
  await page.route('**/api/latest',route=>route.fulfill({json:{record:null,server_now:serverNow}}));
  await page.goto('/?mode=normal');
  await expect(page.locator('#connection')).toHaveText('서버 연결됨');
  await expect(page.locator('#history-day')).toHaveValue('2026-10-22');
  await expect(page.locator('#history-day')).toHaveAttribute('max','2026-10-22');
  await page.locator('#history-panel summary').click();
  await page.locator('#history-day').fill('2026-10-21');
  serverNow='2026-10-22T15:01:00Z';
  await page.locator('#refresh-latest').click();
  await expect(page.locator('#history-day')).toHaveAttribute('max','2026-10-23');
  await expect(page.locator('#history-day')).toHaveValue('2026-10-21');
});


