import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../server/memory-store.mjs';
import { annotateTrendQuality } from '../server/trend-quality.mjs';
import { getTrend, updateTrend } from '../server/trend.mjs';

const base = Date.parse('2026-11-16T01:00:00Z');
const at = seconds => base + seconds * 1000;
const row = (seconds, interval, device = 'fixture') => [
  String(seconds), [at(seconds), 600, 'ok', at(seconds), device, interval],
];
const empty = seconds => ({ time: new Date(at(seconds)).toISOString(), count: 0, invalid_count: 0, complete: true });

function states(bars, entries, end, { start = 0, now = end } = {}) {
  annotateTrendQuality(bars, entries, { start: at(start), end: at(end), period: 60_000 }, at(now));
  return bars.map(bar => bar.empty_state);
}

test('planned blanks stay separate from gaps after the reported deadline', () => {
  const bars = [empty(60), empty(240), empty(300), empty(360)];
  assert.deepEqual(states(bars, [row(10, 300), row(430, 300)], 480), [
    'scheduled', 'scheduled', 'overdue', 'overdue',
  ]);
});

test('grace covers slow recording across a boundary and is distinct from a completed outage', () => {
  const entries = [row(55, 60)];
  assert.deepEqual(states([empty(60), { ...empty(120), complete: false }], entries, 123), ['pending', 'pending']);
  assert.deepEqual(states([empty(60)], entries, 131), ['overdue']);
  assert.deepEqual(states([empty(60)], [...entries, row(121, 60)], 131), ['scheduled']);
  assert.deepEqual(states([empty(60)], entries, 123, { now: 900 }), ['unknown']);
});

test('legacy cadence and device or cadence changes leave the missing interval unknown', () => {
  assert.deepEqual(states([empty(60)], [row(10), row(130, 60)], 180), ['unknown']);
  assert.deepEqual(states([empty(60)], [row(10, 60), row(130, 300)], 180), ['unknown']);
  assert.deepEqual(states([empty(60)], [row(10, 60), row(130, 60, 'other')], 180), ['unknown']);
  assert.deepEqual(states([empty(0)], [row(130, 60)], 180), ['unknown']);
});

test('recorded bars retain their statuses and exact-window exclusions can inform cadence', () => {
  const bars = [empty(60), { ...empty(120), count: 1 }, { ...empty(180), invalid_count: 2 }];
  assert.deepEqual(states(bars, [row(65, 180), row(130, 180)], 240, { start: 80 }), ['scheduled', undefined, undefined]);
});

test('new cadence is indexed alongside legacy records without rereading historical blobs', async () => {
  const store = new MemoryStore();
  const day = '2026-11-16';
  await store.setJSON(`trend/${day}`, { version: 2, day, complete: true, rows: { legacy: row(-180)[1].slice(0, 5) } });
  for (const seconds of [10, 310]) {
    const time = new Date(at(seconds)).toISOString();
    await updateTrend(store, {
      id: String(seconds), device_id: 'fixture', status: 'ok', captured_at: time, recorded_at: time,
      value_c: 600, record_interval_seconds: 300,
    });
  }
  store.list = () => assert.fail('complete indexes should bypass record listing');

  const data = await getTrend(store, { day, minutes: 1, span: 60 }, at(360));
  const barAt = seconds => data.bars.find(bar => Date.parse(bar.time) === at(seconds));
  assert.equal(data.samples, 3);
  assert.equal(barAt(-120).empty_state, 'unknown');
  assert.equal(barAt(240).empty_state, 'scheduled');
  assert.equal(barAt(300).empty_state, undefined);
});
