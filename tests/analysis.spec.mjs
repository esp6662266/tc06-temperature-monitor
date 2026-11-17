import { expect, test } from '@playwright/test';

// Synthetic temperatures and timestamps for the analysis UI.
const day = '2026-11-17';
const now = '2026-11-17T10:15:00.000Z';
const kst = (time, date = day) => new Date(date + 'T' + time + ':00+09:00').toISOString();

function summary(start, end, values) {
  return {
    start, end, average: null, low: null, high: null, samples: 0,
    invalid_samples: 0, rises: 0, falls: 0, ...values,
  };
}

function analysisFixture() {
  const start = Date.parse(kst('08:00'));
  const series = Array.from({length: 180}, (_, minute) => ({
    time: new Date(start + minute * 60000).toISOString(),
    value_c: minute === 115 ? null : 608 + Math.sin(minute / 11) * 2 + minute / 50,
  }));
  series[83].value_c = 609.2;
  series[88].value_c = 617.6;
  series[140].value_c = 614.8;
  series[144].value_c = 608.4;

  return {
    day, oldest_day: '2026-10-19', today: day,
    hourly: [
      summary(kst('09:00'), kst('10:00'), {
        average: 612.4, low: 607.1, high: 619.0, samples: 59, invalid_samples: 1, rises: 1,
      }),
      summary(kst('10:00'), kst('11:00'), {
        average: 613.2, low: 608.4, high: 621.5, samples: 60, falls: 1,
      }),
    ],
    daily: [
      summary(kst('00:00', '2026-11-16'), kst('00:00'), {
        average: 605.2, low: 600.1, high: 619.0, samples: 1270, rises: 3, falls: 2,
      }),
      summary(kst('00:00'), now, {
        average: 611.6, low: 598.2, high: 624.1, samples: 179, invalid_samples: 1, rises: 1, falls: 1,
      }),
    ],
    shifts: [
      summary(kst('20:00', '2026-11-16'), kst('08:00'), {
        shift: 'night', average: 604.1, low: 599.3, high: 614.3, samples: 658, rises: 2, falls: 1,
      }),
      summary(kst('08:00'), kst('20:00'), {
        shift: 'day', average: 612.8, low: 607.1, high: 621.5, samples: 179, invalid_samples: 1, rises: 1, falls: 1,
      }),
    ],
    periods: [
      summary(kst('11:20'), kst('12:00'), {
        period_index: 0, average: 609.5, low: 606.4, high: 613.1, samples: 40, falls: 1,
      }),
      summary(kst('16:20'), kst('17:00'), {period_index: 1}),
    ],
    series,
    events: [
      {start: kst('09:23'), end: kst('09:28'), from_c: 609.2, to_c: 617.6, delta_c: 8.4, direction: 'up'},
      {start: kst('10:20'), end: kst('10:24'), from_c: 614.8, to_c: 608.4, delta_c: -6.4, direction: 'down'},
    ],
  };
}

test('analysis tab compares temperature summaries and traces an event with indicators', async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  await page.route('**/api/latest', route => route.fulfill({json: {server_now: now, record: null}}));
  const fixture = analysisFixture();
  await page.route('**/api/analysis?**', route => route.fulfill({json: fixture}));
  await page.route('**/api/trend?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const end = params.get('as_of') ?? now;
    const endTime = Date.parse(end);
    const time = new Date(Math.floor((endTime - 1) / 60000) * 60000).toISOString();
    const value = 617.6;
    return route.fulfill({json: {
      day, minutes: Number(params.get('minutes')), span: Number(params.get('span')),
      server_now: now, oldest_day: fixture.oldest_day,
      start: new Date(endTime - 3600000).toISOString(), end,
      samples: 1, invalid_samples: 0, low: value, high: value, estimates: [],
      bars: [{time, open: value, high: value, low: value, close: value, count: 1, invalid_count: 0, complete: false}],
    }});
  });

  await page.goto('/?mode=graph');
  const graph = page.locator('#graph-screen');
  await graph.getByRole('button', {name: '온도 분석', exact: true}).click();
  await expect(page).toHaveURL(/mode=analysis/);
  const panel = page.locator('#analysis-screen');
  const rows = page.locator('#analysis-rows');
  await expect(panel).toBeVisible();
  await expect(page.locator('#analysis-shift')).toHaveValue('day');

  await page.locator('#analysis-hourly').click();
  const morning = rows.getByRole('row').filter({hasText: '612.4'});
  await expect(morning).toContainText('619.0');
  await expect(morning).toContainText('59');
  await expect(morning.getByRole('cell', {name: /^1(?:\s*[회건])?$/}).first()).toBeVisible();
  await expect(page.locator('#analysis-bars').getByRole('button')).toHaveCount(2);
  await page.locator('#analysis-bars').getByRole('button', {name: /09:00.*급등 1회/}).click();
  await expect(page.locator('#analysis-chart-period')).toContainText('09:00');
  await expect(page.locator('#analysis-events').getByRole('button')).toHaveCount(1);
  await page.locator('#analysis-reset-range').click();

  await page.locator('#analysis-daily').click();
  await expect(rows.getByRole('row').filter({hasText: '605.2'})).toContainText('1,270');
  await expect(rows).toContainText('611.6');

  await page.locator('#analysis-shifts').click();
  await expect(rows.getByRole('row').filter({hasText: '612.8'})).toContainText('주간');
  const shift = page.locator('#analysis-shift');
  await shift.selectOption('night');
  await expect(rows.getByRole('row').filter({hasText: '604.1'})).toContainText('야간');
  await shift.selectOption('day');
  await expect(rows.getByRole('row').filter({hasText: '612.8'})).toContainText('주간');

  await page.locator('#analysis-periods').click();
  await expect(rows.getByRole('row').filter({hasText: '609.5'})).toContainText('점심');
  await expect(rows.getByRole('row').filter({hasText: '참시간'})).toContainText('16:20');
  await page.locator('#analysis-period-settings summary').click();
  await page.locator('#analysis-period-list .analysis-slot-start').first().fill('11:30');
  await page.locator('#analysis-change').fill('8');
  const thresholdResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.ok() && url.pathname === '/api/analysis' && url.searchParams.get('change_c') === '8';
  });
  await page.locator('#analysis-load').click();
  const query = new URL((await thresholdResponse).url()).searchParams;
  expect(query.get('day')).toBe(day);
  expect(query.get('periods')).toBe('11:30-12:00,16:20-17:00');

  const temperature = page.locator('#analysis-temperature-chart');
  const macd = page.locator('#analysis-macd-chart');
  await expect(temperature.locator('.analysis-temp-line').first()).toBeVisible();
  await expect(page.locator('#analysis-average')).toBeChecked();
  await expect(temperature.locator('.analysis-ma-short').first()).toBeVisible();
  await page.locator('#analysis-bands').check();
  await expect(temperature.locator('.analysis-bollinger-band').first()).toBeVisible();
  await page.locator('#analysis-macd-toggle').check();
  await expect(macd.locator('.analysis-macd-line').first()).toBeVisible();

  await page.setViewportSize({width: 390, height: 844});
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#analysis-events').getByRole('button', {name: /급등.*8[.,]4|8[.,]4.*급등/}).first().click();
  await expect(temperature.locator('.analysis-chart-event')).toBeVisible();
  const original = page.locator('#analysis-original');
  await expect(original).toBeVisible();
  const sourceUrl = new URL(await original.getAttribute('href'), page.url());
  expect(sourceUrl.searchParams.get('mode')).toBe('graph');
  expect(sourceUrl.searchParams.get('day')).toBe(day);
  expect(sourceUrl.searchParams.get('span')).toBe('60');
  const at = sourceUrl.searchParams.get('at');
  expect(at).toMatch(/^2026-11-17T/);
  const anchored = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/trend' && url.searchParams.has('as_of');
  });
  await original.click();
  await expect(graph).toBeVisible();
  const graphQuery = new URL((await anchored).url()).searchParams;
  expect(graphQuery.get('as_of')).toBe(new Date(Date.parse(at) + 1).toISOString());
  await expect(page.locator('#graph-detail')).toContainText('마지막 617.6 ℃');
  const live = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/trend' && !url.searchParams.has('as_of');
  });
  await page.locator('#graph-live').click();
  await live;
  expect(new URL(page.url()).searchParams.has('at')).toBe(false);
});
