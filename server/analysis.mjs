import { validInterval } from './collection.mjs';
import { dayKST, oldestDay } from './retention.mjs';
import { readDay, validDay } from './trend.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIRST_SHIFT = 8 * HOUR;
const SHIFT_LENGTH = 12 * HOUR;
const dayStart = day => Date.parse(day + 'T00:00:00+09:00');
const iso = at => new Date(at).toISOString();
const isMeasured = row => row[2] === 'ok' && Number.isFinite(row[1]);
const deltaC = (from, to) => Number((to - from).toFixed(1));

function parsePeriods(value) {
  if (!value) return [];
  const ranges = value.split(',');
  if (ranges.length > 6) return null;
  const periods = [];
  for (const range of ranges) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(range);
    if (!match) return null;
    const start = Number(match[1]) * HOUR + Number(match[2]) * MINUTE;
    const end = Number(match[3]) * HOUR + Number(match[4]) * MINUTE;
    if (end <= start) return null;
    periods.push({ start, end });
  }
  return periods;
}

function summary(start, end) {
  return { start, end, sum: 0, low: null, high: null, samples: 0, invalid_samples: 0, comparable_pairs: 0, rises: 0, falls: 0 };
}

function record(bucket, row) {
  if (!isMeasured(row)) {
    bucket.invalid_samples++;
    return;
  }
  const value = row[1];
  bucket.sum += value;
  bucket.low = Math.min(bucket.low ?? value, value);
  bucket.high = Math.max(bucket.high ?? value, value);
  bucket.samples++;
}

function serialize({ sum, start, end, ...stats }) {
  return { start: iso(start), end: iso(end), average: stats.samples ? sum / stats.samples : null, ...stats };
}

function consecutive(previous, current) {
  const previousInterval = validInterval(previous[5]) ? previous[5] : null;
  const currentInterval = validInterval(current[5]) ? current[5] : null;
  const interval = previousInterval ?? currentInterval ?? 60;
  const elapsed = current[0] - previous[0];
  return previous[4] === current[4] && (!previousInterval || !currentInterval || previousInterval === currentInterval) &&
    elapsed > 0 && elapsed <= interval * 1500;
}

function swings(rows, threshold, window, onComparable) {
  const events = [];
  const directions = [{ direction: 'up', sign: 1 }, { direction: 'down', sign: -1 }];
  let previous = null;
  // Each ordered queue keeps the strongest starting point within the window at its head.
  for (const row of rows) {
    const measured = isMeasured(row);
    const adjacent = previous && measured && consecutive(previous, row);
    if (adjacent) {
      if (row[0] - previous[0] <= window) onComparable(previous[0]);
    } else {
      for (const side of directions) {
        side.points = [];
        side.head = 0;
        side.active = null;
      }
    }
    previous = measured ? row : null;
    if (!measured) continue;
    const [time, value] = row;
    for (const side of directions) {
      const { points, sign, direction } = side;
      while (side.head < points.length && points[side.head][0] < time - window) side.head++;
      const start = points[side.head];
      if (start && sign * (value - start[1]) + 1e-8 >= threshold) {
        if (!side.active || start[0] > side.active.lastConfirmation) {
          side.active = {
            start: start[0], end: time, from_c: start[1], to_c: value, direction,
            qualified_at: time, qualified_delta_c: deltaC(start[1], value),
          };
          events.push(side.active);
        } else if (time - side.active.start <= window && sign * (value - side.active.to_c) > 0) {
          // Keep the displayed measurement pair within the chosen threshold window.
          side.active.end = time;
          side.active.to_c = value;
        }
        side.active.lastConfirmation = time;
      }
      while (points.length > side.head && sign * (points.at(-1)[1] - value) > 0) points.pop();
      points.push(row);
    }
  }
  return events.sort((a, b) => a.start - b.start || a.end - b.end);
}

async function loadRows(store, start, end) {
  const days = [];
  for (let at = start; at < end; at += DAY) days.push(dayKST(at));
  const entries = [];
  for (let i = 0; i < days.length; i += 5) {
    const batch = await Promise.all(days.slice(i, i + 5).map(async day => {
      const index = await store.get(`trend/${day}`, { type: 'json', consistency: 'strong' });
      if (index?.complete && [1, 2].includes(index.version)) return index;
      return readDay(store, day);
    }));
    for (const index of batch) {
      for (const [id, row] of Object.entries(index.rows)) {
        if (row[0] >= start && row[0] < end) entries.push([id, row]);
      }
    }
  }
  entries.sort((a, b) => a[1][0] - b[1][0] || a[1][3] - b[1][3] || a[0].localeCompare(b[0]));
  return entries.map(([, row]) => row);
}

export async function getAnalysis(store, {
  day, days = 7, changeC = 5, windowMinutes = 5, periods: periodOptions = '',
} = {}, now = Date.now()) {
  const today = dayKST(now);
  const oldest = oldestDay(now);
  day ??= today;
  const requestedPeriods = parsePeriods(periodOptions);
  if (!validDay(day) || day > today || ![1, 7, 30].includes(days) || !Number.isFinite(changeC) ||
      changeC < 0.1 || changeC > 9999.9 || Math.abs(changeC * 10 - Math.round(changeC * 10)) > 1e-8 ||
      !Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 60 || !requestedPeriods) {
    return { error: '분석 날짜, 기간, 변동 기준 또는 시간 구간을 확인해 주세요.', status: 400 };
  }
  if (day < oldest) return { error: '30일 보관 기간이 지난 날짜입니다.', status: 410 };

  const selected = dayStart(day);
  const oldestStart = dayStart(oldest);
  const first = Math.max(oldestStart, selected - (days - 1) * DAY);
  const chartEnd = Math.min(selected + DAY + FIRST_SHIFT, now);
  const window = windowMinutes * MINUTE;
  const seriesEnd = Math.min(chartEnd + window, now);
  const hourlies = [];
  const dailies = [];
  const shifts = [];
  const periods = [];
  const periodsByDay = new Map();
  for (let start = first; start <= selected; start += DAY) {
    dailies.push(summary(start, Math.min(start + DAY, now)));
    for (const [offset, shift] of [[FIRST_SHIFT, 'day'], [FIRST_SHIFT + SHIFT_LENGTH, 'night']]) {
      const shiftStart = start + offset;
      if (shiftStart < now) shifts.push({ ...summary(shiftStart, Math.min(shiftStart + SHIFT_LENGTH, now)), shift });
    }
    const blocks = [];
    for (const [index, block] of requestedPeriods.entries()) {
      if (start + block.start < now) {
        blocks.push({ ...summary(start + block.start, Math.min(start + block.end, now)), period_index: index });
      }
    }
    periodsByDay.set(start, blocks);
    periods.push(...blocks);
  }
  periods.sort((a, b) => a.start - b.start || a.period_index - b.period_index);
  for (let start = selected; start < chartEnd; start += HOUR) {
    hourlies.push(summary(start, Math.min(start + HOUR, chartEnd)));
  }
  const series = [];
  for (let start = selected; start < seriesEnd; start += MINUTE) series.push({ time: iso(start), value_c: null });

  // Include the surrounding calendar days so a continuous excursion can start
  // on one date and finish on the next without being counted twice.
  const rows = await loadRows(store, Math.max(oldestStart, first - DAY), seriesEnd);
  function forBuckets(time, callback) {
    const dayIndex = Math.floor((time - first) / DAY);
    const hour = hourlies[Math.floor((time - selected) / HOUR)];
    const daily = dailies[dayIndex];
    const shift = shifts[Math.floor((time - first - FIRST_SHIFT) / SHIFT_LENGTH)];
    if (daily && time < daily.end) callback(daily);
    if (hour && time < hour.end) callback(hour);
    if (shift && time < shift.end) callback(shift);
    for (const period of periodsByDay.get(first + dayIndex * DAY) ?? []) {
      if (time >= period.start && time < period.end) callback(period);
    }
  }
  let previousRow = null;
  for (const row of rows) {
    const [time, value] = row;
    forBuckets(time, bucket => record(bucket, row));
    const point = series[Math.floor((time - selected) / MINUTE)];
    if (point && isMeasured(row)) {
      point.value_c = value;
      if (previousRow && (!isMeasured(previousRow) || !consecutive(previousRow, row))) point.break_before = true;
    }
    previousRow = row;
  }
  const events = [];
  for (const event of swings(rows, changeC, window, time => forBuckets(time, bucket => bucket.comparable_pairs++))) {
    const counter = event.direction === 'up' ? 'rises' : 'falls';
    forBuckets(event.start, bucket => bucket[counter]++);
    if (event.start < selected || event.start >= chartEnd) continue;
    const { start, end, from_c, to_c, direction, qualified_at, qualified_delta_c } = event;
    events.push({
      start: iso(start), end: iso(end), from_c, to_c, delta_c: deltaC(from_c, to_c), direction,
      qualified_at: iso(qualified_at), qualified_delta_c,
    });
  }

  return {
    day, today, oldest_day: oldest, hourly: hourlies.map(serialize), daily: dailies.map(serialize),
    shifts: shifts.map(serialize), periods: periods.map(serialize), series, events,
  };
}
