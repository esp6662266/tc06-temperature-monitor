import { updateTrend, getTrend, readDay } from './trend.mjs';
import { estimateAt, ESTIMATE_STATUSES, MAX_ESTIMATE_MS } from './estimate.mjs';
import { RETENTION_DAYS, dayKST, oldestDay, expired } from './retention.mjs';

const STATUSES = new Set(['ok', 'anchor_missing', 'ambiguous_anchor', 'occluded', 'ocr_failed',
  'value_suspect', 'low_confidence', 'freshness_unverified', 'stale_source', 'source_error', 'window_missing', 'ocr_timeout']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGE_MS = 150_000;
const MAX_BODY = 2_000_000;
const recordKey = record => `records/${dayKST(record.captured_at)}/${record.id}`;
const rank = record => `${record.captured_at}|${record.recorded_at}|${record.id}`;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Netlify-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra,
  }});
}

async function bodyJSON(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Error('JSON body required');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('Request too large'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function validateRecord(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !UUID.test(raw.id) || raw.asset !== 'TC-06' ||
      typeof raw.device_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.device_id) || !STATUSES.has(raw.status)) throw new Error('Invalid record identity/status');
  for (const key of ['captured_at', 'recorded_at']) {
    if (typeof raw[key] !== 'string' || !/Z$|\+00:00$/.test(raw[key]) || !Number.isFinite(Date.parse(raw[key])) ||
        Date.parse(raw[key]) > now + 30_000) throw new Error('Invalid UTC timestamp / PC clock ahead');
  }
  if (Date.parse(raw.captured_at) > Date.parse(raw.recorded_at) + 1000) throw new Error('Capture cannot follow recording');
  if (raw.status === 'ok' && (typeof raw.value_c !== 'number' || !Number.isFinite(raw.value_c) ||
      Math.abs(raw.value_c) > 9999.9 || Math.abs(raw.value_c * 10 - Math.round(raw.value_c * 10)) > .00001)) throw new Error('Invalid temperature');
  if (raw.status !== 'ok' && raw.value_c !== null) throw new Error('Invalid readings must have null value');
  if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 100) throw new Error('Invalid confidence');
  if (raw.status === 'ok' && (!/^\d{1,2}:\d{2}:\d{2}$/.test(raw.source_clock || '') || raw.confidence < 60)) throw new Error('Missing quality evidence');
  return { id: raw.id, asset: 'TC-06', device_id: raw.device_id,
    captured_at: new Date(raw.captured_at).toISOString(), recorded_at: new Date(raw.recorded_at).toISOString(),
    status: raw.status, value_c: raw.value_c, confidence: raw.confidence,
    source_clock: typeof raw.source_clock === 'string' ? raw.source_clock.slice(0, 16) : null };
}

export async function updateLatest(store, record, key = 'latest') {
  // Conditional writes prevent old retries and concurrent requests from replacing newer state.
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    if (previous?.data && rank(previous.data) >= rank(record)) return;
    const condition = previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true };
    const outcome = await store.setJSON(key, record, condition);
    if (outcome.modified) return;
  }
  throw new Error('Latest conflict; retry upload');
}

const normal = (record, now) => record?.asset === 'TC-06' && record.status === 'ok' && Number.isFinite(record.value_c) &&
  Number.isFinite(Date.parse(record.captured_at)) && Date.parse(record.captured_at) <= now + 30_000 && !expired(record, now);

export async function lastGood(store, current, now = Date.now()) {
  const previous = await store.getWithMetadata('last-good', { type: 'json', consistency: 'strong' });
  if (normal(current, now) && (!previous?.data || rank(current) > rank(previous.data))) {
    await updateLatest(store, current, 'last-good');
  } else if (!previous) {
    // One-time upgrade: recover the real newest normal record, not a new reading.
    const days = new Set();
    for await (const page of store.list({ prefix: 'records/', directories: true, paginate: true })) {
      for (const directory of page.directories || []) {
        const match = directory.match(/^(?:records\/)?(\d{4}-\d{2}-\d{2})\/?$/);
        if (match && match[1] >= oldestDay(now) && match[1] <= dayKST(now)) days.add(match[1]);
      }
    }
    let found = false;
    for (const day of [...days].sort().reverse()) {
      const index = await readDay(store, day);
      const candidates = Object.entries(index.rows).filter(([, row]) => row[2] === 'ok' && Number.isFinite(row[1]) && row[0] <= now + 30_000)
        .sort((a, b) => b[1][0] - a[1][0] || b[1][3] - a[1][3] || b[0].localeCompare(a[0]));
      for (const [id] of candidates) {
        const record = await store.get(`records/${day}/${id}`, { type: 'json', consistency: 'strong' });
        if (normal(record, now)) { await updateLatest(store, record, 'last-good'); found = true; break; }
      }
      if (found) break;
    }
    if (!found) await store.setJSON('last-good', null, { onlyIfNew: true });
  } else {
    return normal(previous.data, now) ? previous.data : null;
  }
  const stored = await store.get('last-good', { type: 'json', consistency: 'strong' });
  return normal(stored, now) ? stored : null;
}

export async function currentEstimate(store, current, last, now=Date.now()) {
  if (!current || !last || !ESTIMATE_STATUSES.has(current.status) || current.device_id!==last.device_id ||
      Date.parse(current.captured_at)<=Date.parse(last.captured_at) || now-Date.parse(last.captured_at)>MAX_ESTIMATE_MS) return null;
  const days=[...new Set([dayKST(Math.max(now-6*60000,Date.parse(oldestDay(now)+'T00:00:00+09:00'))),dayKST(now)])];
  const indexes=await Promise.all(days.map(day=>readDay(store,day)));
  return estimateAt(indexes.flatMap(index=>Object.entries(index.rows)),now,current.device_id,last.id);
}

export function createAPI(getStore) {
  return async function handle(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean).pop();
    const method = request.method;
    if (action === 'ingest') {
      if (method !== 'POST') return json({ error: 'POST required' }, 405);
      let body, record;
      try {
        body = await bodyJSON(request);
        record = validateRecord(body.record);
        if (expired(record)) return json({ error: '30일 보관 기간이 지난 기록입니다', id: record.id, discarded: 'retention_expired' }, 410);
      } catch (error) { return json({ error: error.message }, 400); }
      try {
        const store = getStore();
        // Old collectors may send legacy audio fields; discard them without storage.
        const stored = { ...record, received_at: new Date().toISOString() };
        const key = recordKey(record);
        await store.setJSON(key, stored, { onlyIfNew: true });
        // Use canonical first-write content on retries; immutable record history.
        const canonical = await store.get(key, { type: 'json', consistency: 'strong' });
        await updateTrend(store, canonical);
        if (canonical.status === 'ok') await updateLatest(store, canonical, 'last-good');
        await updateLatest(store, canonical);
        return json({ saved: true, id: canonical.id });
      } catch { return json({ error: '저장 실패. 같은 id로 재전송하세요' }, 503); }
    }
    if (method !== 'GET') return json({ error: 'GET required' }, 405);
    try {
      const store = getStore();
      if (action === 'latest') {
        const stored = await store.get('latest', { type: 'json', consistency: 'strong' });
        const record = stored && !expired(stored) ? stored : null;
        const ageMs = record ? Date.now() - Date.parse(record.captured_at) : null;
        const last_good = await lastGood(store, record);
        let estimate=null;try{estimate=await currentEstimate(store,record,last_good);}catch{/* Optional forecast cannot hide real records on failure. */}
        if(estimate && Date.parse(estimate.expires_at)<Date.now())estimate=null;
        return json({ retention_days: RETENTION_DAYS, oldest_day: oldestDay(), record, last_good, estimate, server_now: new Date().toISOString(), max_age_ms: AGE_MS,
          fresh: Boolean(record && ageMs >= -30_000 && ageMs <= AGE_MS) });
      }
      if (action === 'audio') return json({ error: '웹 숫자 TTS로 전환되어 서버 음성 저장을 종료했습니다' }, 410);
      if (action === 'retention') return json({ retention_days: RETENTION_DAYS, oldest_day: oldestDay(), timezone: 'Asia/Seoul',
        cleanup_schedule: '매시 15분', last_cleanup: await store.get('maintenance/retention', { type: 'json' }) });
      if (action === 'trend') {
        const result=await getTrend(store,{day:url.searchParams.get('day')||dayKST(Date.now()),minutes:Number(url.searchParams.get('minutes')||1),span:Number(url.searchParams.get('span')||360)});
        return json(result,result.status||200);
      }
      if (action === 'history') {
        const day = url.searchParams.get('day') || dayKST(new Date().toISOString());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day) return json({ error: 'Invalid date' }, 400);
        if (day < oldestDay()) return json({ error: '30일 보관 기간이 지난 날짜입니다', oldest_day: oldestDay() }, 410);
        const keys = [];
        for await (const page of store.list({ prefix: `records/${day}/`, paginate: true })) {
          keys.push(...page.blobs.map(blob => blob.key));
          if (keys.length > 3000) return json({ error: '일별 기록이 3000개를 초과했습니다' }, 413);
        }
        const records = [];
        for (let i = 0; i < keys.length; i += 20) {
          records.push(...(await Promise.all(keys.slice(i, i + 20).map(key => store.get(key, { type: 'json', consistency: 'strong' })))).filter(Boolean));
        }
        records.sort((a, b) => rank(a).localeCompare(rank(b)));
        const columns = ['id', 'asset', 'device_id', 'captured_at', 'recorded_at', 'received_at', 'value_c', 'status', 'source_clock', 'confidence'];
        const csv = '\uFEFF' + [columns.join(','), ...records.map(row => columns.map(key => JSON.stringify(String(row[key] ?? ''))).join(','))].join('\r\n');
        return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="TC06-${day}-KST.csv"` } });
      }
      return json({ error: 'Not found' }, 404);
    } catch { return json({ error: '서버 저장소 조회 실패' }, 503); }
  };
}
