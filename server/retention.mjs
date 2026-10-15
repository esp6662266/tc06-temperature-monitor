export const RETENTION_DAYS = 30;
export const dayKST = value => new Date(new Date(value).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
export function oldestDay(now = Date.now()) {
  return dayKST(new Date(now).getTime() - (RETENTION_DAYS - 1) * 86400_000);
}
export function expired(record, now = Date.now()) {
  return dayKST(record.captured_at) < oldestDay(now);
}

// Whole KST dates: today and the previous 29 dates. Only known application keys
// are deleted. A bounded hourly run resumes safely after limits or failures.
export async function cleanupStore(store, { now = Date.now(), limit = 2000, budgetMs = 22000 } = {}) {
  const started = Date.now(), cutoff = oldestDay(now);
  const summary = { ran_at: new Date(now).toISOString(), retention_days: RETENTION_DAYS,
    oldest_day: cutoff, deleted_records: 0, deleted_audio: 0, deleted_trends: 0, cleared_latest: false, limit_reached: false };
  const dates = new Set();
  for await (const page of store.list({ prefix: 'records/', directories: true, paginate: true })) {
    for (const directory of page.directories || []) {
      const match = directory.match(/^(?:records\/)?(\d{4}-\d{2}-\d{2})\/?$/);
      if (match && match[1] < cutoff) dates.add(match[1]);
    }
  }
  const prefixes = [...[...dates].sort().map(day => `records/${day}/`), 'audio/', 'trend/'];
  const recordPattern = /^records\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  outer: for (const prefix of prefixes) {
    for await (const page of store.list({ prefix, paginate: true })) {
      const keys = page.blobs.map(blob => blob.key).filter(key => prefix === 'audio/'
        ? /^audio\/(?:[a-f0-9]{64}|notice-stale)$/.test(key) : prefix === 'trend/' ? /^trend\/\d{4}-\d{2}-\d{2}$/.test(key) && key.slice(6)<cutoff : recordPattern.test(key));
      for (let i = 0; i < keys.length; i += 20) {
        const count = summary.deleted_records + summary.deleted_audio + summary.deleted_trends;
        if (count >= limit || Date.now() - started >= budgetMs) { summary.limit_reached = true; break outer; }
        const batch = keys.slice(i, Math.min(i + 20, i + limit - count));
        await Promise.all(batch.map(key => store.delete(key)));
        if (prefix === 'audio/') summary.deleted_audio += batch.length;
        else if (prefix === 'trend/') summary.deleted_trends += batch.length;
        else summary.deleted_records += batch.length;
        if (batch.length < Math.min(20, keys.length-i)) { summary.limit_reached = true; break outer; }
      }
    }
  }
  const latest = await store.getWithMetadata('latest', { type: 'json', consistency: 'strong' });
  if (latest?.data && expired(latest.data, now)) {
    // A conditional null tombstone cannot erase a simultaneous new reading.
    const result = await store.setJSON('latest', null, { onlyIfMatch: latest.etag });
    summary.cleared_latest = result.modified;
  }
  await store.setJSON('maintenance/retention', summary);
  return summary;
}
