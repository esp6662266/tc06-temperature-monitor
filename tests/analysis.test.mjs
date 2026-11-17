import assert from 'node:assert/strict';
import test from 'node:test';
import { getAnalysis } from '../server/analysis.mjs';
import { createAPI } from '../server/api.mjs';
import { MemoryStore } from '../server/memory-store.mjs';
import { dayKST, oldestDay } from '../server/retention.mjs';

const day = '2026-11-16';
const nextDay = '2026-11-17';
const at = (time, date = day) => Date.parse(`${date}T${time}+09:00`);
const iso = (time, date) => new Date(at(time, date)).toISOString();
const entry = (time, value, date = day, interval = 60) => {
  const timeMs = at(time, date);
  return [timeMs, value, value === null ? 'ocr_failed' : 'ok', timeMs, 'synthetic-collector', interval];
};
async function seed(store, date, rows) {
  await store.setJSON(`trend/${date}`, {
    version: 2, complete: true, day: date,
    rows: Object.fromEntries(rows.map((row, index) => [String(index), row])),
  });
}

test('analysis averages every measured row and leaves missing and failed minute slots empty', async () => {
  const store = new MemoryStore();
  await seed(store, day, [
    entry('09:00:08', 600), entry('09:00:38', 601), entry('09:01:08', null), entry('10:00:08', 604),
    entry('10:00:20', null), entry('10:00:35', 604),
    entry('10:02:00', 999),
  ]);
  const data = await getAnalysis(store, { day, days: 1 }, at('10:01:45'));
  const [nine, ten] = data.hourly.slice(-2);
  assert.deepEqual([nine.average, nine.low, nine.high, nine.samples, nine.invalid_samples], [600.5, 600, 601, 2, 1]);
  assert.equal(ten.end, iso('10:01:45'));
  assert.equal(ten.average, 604);
  assert.equal(nine.comparable_pairs, 1);
  assert.equal(ten.comparable_pairs, 0);
  assert.equal(data.daily[0].average, 2409 / 4);
  assert.equal(data.series.at(-1).time, iso('10:01:00'));
  assert.deepEqual(data.series.slice(540, 543), [
    { time: iso('09:00:00'), value_c: 601 },
    { time: iso('09:01:00'), value_c: null },
    { time: iso('09:02:00'), value_c: null },
  ]);
  assert.deepEqual(data.series[600], { time: iso('10:00:00'), value_c: 604, break_before: true });
});

test('analysis coalesces overlapping swings and does not compare across missing or failed records', async () => {
  const store = new MemoryStore();
  await seed(store, day, [
    entry('09:00:00', 600), entry('09:01:02', 602), entry('09:02:01', 605.4),
    entry('09:03:00', 607), entry('09:04:00', 610),
    entry('09:07:00', 600), entry('09:08:00', 597.5), entry('09:09:00', 594.9),
    entry('09:10:00', null), entry('09:11:00', 605), entry('09:12:00', 605.1),
  ]);
  const data = await getAnalysis(store, { day, days: 1, changeC: 5, windowMinutes: 3 }, at('09:15:00'));
  assert.deepEqual(data.events, [
    { start: iso('09:00:00'), end: iso('09:03:00'), from_c: 600, to_c: 607, delta_c: 7, direction: 'up',
      qualified_at: iso('09:02:01'), qualified_delta_c: 5.4 },
    { start: iso('09:07:00'), end: iso('09:09:00'), from_c: 600, to_c: 594.9, delta_c: -5.1, direction: 'down',
      qualified_at: iso('09:09:00'), qualified_delta_c: -5.1 },
  ]);
  assert.deepEqual([data.hourly[9].rises, data.hourly[9].falls, data.hourly[9].comparable_pairs], [1, 1, 7]);
  assert.deepEqual([data.daily[0].rises, data.daily[0].falls], [1, 1]);
});

test('night shift spans midnight and custom periods use their requested boundaries and ordering', async () => {
  const store = new MemoryStore();
  await seed(store, day, [
    entry('11:19:59', 602), entry('11:20:00', 600), entry('11:21:00', 606), entry('12:00:00', 610),
    entry('19:59:00', 601), entry('20:00:00', 601), entry('23:59:00', 600),
  ]);
  await seed(store, nextDay, [
    entry('00:00:00', 603, nextDay), entry('00:01:00', 607, nextDay),
    entry('07:57:00', 700, nextDay), entry('07:58:00', 701, nextDay), entry('07:59:00', 702, nextDay),
    entry('08:00:00', 703, nextDay), entry('08:01:00', 704, nextDay), entry('08:02:00', 706, nextDay),
  ]);
  const data = await getAnalysis(store, {
    day, days: 1, periods: '11:21-11:30,11:20-12:00,16:20-17:00',
  }, at('08:35:00', nextDay));
  const [dayShift, night] = data.shifts;
  assert.deepEqual([dayShift.shift, dayShift.start, dayShift.end, dayShift.samples, dayShift.rises],
    ['day', iso('08:00:00'), iso('20:00:00'), 5, 1]);
  assert.deepEqual([night.shift, night.start, night.end, night.samples, night.rises],
    ['night', iso('20:00:00'), iso('08:00:00', nextDay), 7, 2]);
  assert.equal(night.average, 4514 / 7);
  assert.equal(data.daily[0].samples, 7);
  assert.equal(data.daily[0].rises, 2);
  assert.equal(data.hourly[23].rises, 1);
  assert.deepEqual([data.hourly[24].start, data.hourly[24].samples], [iso('00:00:00', nextDay), 2]);
  assert.deepEqual(data.periods.map(block => [block.period_index, block.samples, block.average, block.rises]),
    [[1, 2, 603, 1], [0, 1, 606, 0], [2, 0, null, 0]]);
  assert.deepEqual(data.events.at(-2), {
    start: iso('23:59:00'), end: iso('00:01:00', nextDay), from_c: 600, to_c: 607, delta_c: 7, direction: 'up',
    qualified_at: iso('00:01:00', nextDay), qualified_delta_c: 7,
  });
  assert.deepEqual(data.events.at(-1), {
    start: iso('07:57:00', nextDay), end: iso('08:02:00', nextDay), from_c: 700, to_c: 706, delta_c: 6, direction: 'up',
    qualified_at: iso('08:02:00', nextDay), qualified_delta_c: 6,
  });
  assert.equal(data.hourly.at(-1).end, iso('08:00:00', nextDay));
  assert.equal(data.series.at(-1).time, iso('08:04:00', nextDay));
  assert.equal(data.series.find(point => point.time === iso('08:02:00', nextDay)).value_c, 706);
  assert.equal(data.series.find(point => point.time === iso('00:01:00', nextDay)).value_c, 607);
});

test('analysis route validates options and bounds history by KST retention', async () => {
  const now = Date.parse('2026-11-16T15:29:00Z');
  const store = new MemoryStore();
  const oldest = oldestDay(now);
  const data = await getAnalysis(store, { day: oldest, days: 30 }, now);
  assert.equal(data.daily.length, 1);
  assert.equal(dayKST(data.daily[0].start), oldest);
  assert.equal(data.hourly.length, 32);
  assert.equal(data.daily[0].average, null);
  for (const options of [
    { day: '2026-11-31' }, { day: '2026-11-18' }, { days: 4 }, { windowMinutes: 0 }, { changeC: 0.01 },
    { periods: '9:00-10:00' }, { periods: '11:30-10:00' }, { periods: '11:10-11:10' },
  ]) {
    assert.equal((await getAnalysis(store, options, now)).status, 400);
  }
  const api = createAPI(() => store);
  assert.equal((await api(new Request('https://example.invalid/api/analysis?day=2020-01-01'))).status, 410);
  assert.equal((await api(new Request('https://example.invalid/api/analysis?days=31'))).status, 400);
  assert.equal((await api(new Request('https://example.invalid/api/analysis', { method: 'POST' }))).status, 405);
});

test('analysis uses complete legacy indexes without rereading raw history', async () => {
  const store = new MemoryStore();
  await store.setJSON(`trend/${day}`, {
    version: 1, complete: true, day,
    rows: { first: entry('08:00:00', 600).slice(0, 5), second: entry('08:01:00', 606).slice(0, 5) },
  });
  const list = store.list.bind(store);
  store.list = options => {
    assert.notEqual(options.prefix, `records/${day}/`);
    return list(options);
  };
  const data = await getAnalysis(store, { day, days: 1 }, at('08:10:00'));
  assert.deepEqual([data.daily[0].average, data.daily[0].rises], [603, 1]);
  assert.equal((await store.get(`trend/${day}`, { type: 'json' })).version, 1);
});
