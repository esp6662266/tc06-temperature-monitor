import { createHash } from 'node:crypto';

const STATUSES = new Set(['ok', 'anchor_missing', 'ambiguous_anchor', 'occluded', 'ocr_failed',
  'value_suspect', 'low_confidence', 'freshness_unverified', 'stale_source', 'source_error', 'window_missing']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGE_MS = 150_000;
const MAX_BODY = 2_000_000;
const dayKST = iso => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
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

function wavBytes(base64) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid audio');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 44 || bytes.length > 700_000 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected WAV audio');
  return bytes;
}

export async function updateLatest(store, record) {
  // Conditional writes prevent old retries and concurrent requests from replacing newer state.
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await store.getWithMetadata('latest', { type: 'json', consistency: 'strong' });
    if (previous && rank(previous.data) >= rank(record)) return;
    const condition = previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true };
    const outcome = await store.setJSON('latest', record, condition);
    if (outcome.modified) return;
  }
  throw new Error('Latest conflict; retry upload');
}

export function createAPI(getStore) {
  return async function handle(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean).pop();
    const method = request.method;
    if (action === 'ingest') {
      if (method !== 'POST') return json({ error: 'POST required' }, 405);
      let body, record, audio, notice;
      try {
        body = await bodyJSON(request);
        record = validateRecord(body.record);
        if (body.audio_base64) audio = wavBytes(body.audio_base64);
        if (body.notice_audio_base64) notice = wavBytes(body.notice_audio_base64);
        if (body.audio_hash && !/^[a-f0-9]{64}$/.test(body.audio_hash)) throw new Error('Invalid audio hash');
        if (audio && body.audio_hash && createHash('sha256').update(audio).digest('hex') !== body.audio_hash) throw new Error('Audio hash mismatch');
      } catch (error) { return json({ error: error.message }, 400); }
      try {
        const store = getStore();
        const audioId = audio ? createHash('sha256').update(audio).digest('hex') : body.audio_hash || null;
        const audioKey = audioId ? `audio/${audioId}` : null;
        if (audio) await store.set(audioKey, audio, { onlyIfNew: true });
        else if (audioId && !await store.getMetadata(audioKey, { consistency: 'strong' })) throw new Error('Audio must be reuploaded');
        if (notice) await store.set('audio/notice-stale', notice, { onlyIfNew: true });
        const stored = { ...record, received_at: new Date().toISOString(), has_audio: Boolean(audioId), audio_id: audioId };
        const key = recordKey(record);
        await store.setJSON(key, stored, { onlyIfNew: true });
        // Use canonical first-write content on retries; immutable record history.
        const canonical = await store.get(key, { type: 'json', consistency: 'strong' });
        await updateLatest(store, canonical);
        return json({ saved: true, id: canonical.id });
      } catch { return json({ error: '저장 실패. 같은 id로 재전송하세요' }, 503); }
    }
    if (method !== 'GET') return json({ error: 'GET required' }, 405);
    try {
      const store = getStore();
      if (action === 'latest') {
        const record = await store.get('latest', { type: 'json', consistency: 'strong' });
        const ageMs = record ? Date.now() - Date.parse(record.captured_at) : null;
        return json({ record, server_now: new Date().toISOString(), max_age_ms: AGE_MS,
          fresh: Boolean(record && ageMs >= -30_000 && ageMs <= AGE_MS) });
      }
      if (action === 'audio') {
        const id = url.searchParams.get('id');
        if (id !== 'notice-stale' && !/^[a-f0-9]{64}$/.test(id || '')) return json({ error: 'Invalid audio id' }, 400);
        const data = await store.get(`audio/${id}`, { type: 'arrayBuffer', consistency: 'strong' });
        if (!data) return json({ error: '음성 파일 없음' }, 404);
        return new Response(data, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (action === 'history') {
        const day = url.searchParams.get('day') || dayKST(new Date().toISOString());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day))) return json({ error: 'Invalid date' }, 400);
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
