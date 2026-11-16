import { validInterval } from './collection.mjs';

// Recording can slip a few seconds into the next bucket as OCR retries.
const RECORDING_GRACE_MS = 15_000;

function emptyState(bar, bucketEnd, previous, next, { end }, now) {
  if (!bar.complete) return 'pending';
  if (!previous || !validInterval(previous[5])) return 'unknown';
  if (next && (next[4] !== previous[4] || next[5] !== previous[5])) return 'unknown';

  const dueAt = previous[0] + previous[5] * 1000;
  const deadline = dueAt + RECORDING_GRACE_MS;
  if (bucketEnd <= dueAt || (next && next[0] <= deadline)) return 'scheduled';
  if (end < deadline) return end === now ? 'pending' : 'unknown';
  return 'overdue';
}

// Entries are sorted by capture time during aggregation. Keep legacy indexed
// records usable without rebuilding indexes or assuming today's configuration.
export function annotateTrendQuality(bars, entries, window, now) {
  let index = 0;
  let previous;
  for (const bar of bars) {
    const time = Date.parse(bar.time);
    const start = Math.max(time, window.start);
    while (index < entries.length && entries[index][1][0] < start) {
      previous = entries[index++][1];
    }
    if (bar.count || bar.invalid_count) continue;

    const candidate = entries[index]?.[1];
    const next = candidate && candidate[0] < window.end ? candidate : undefined;
    const end = Math.min(time + window.period, window.end);
    bar.empty_state = emptyState(bar, end, previous, next, window, now);
  }
}
