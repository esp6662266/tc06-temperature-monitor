import { dayKST, oldestDay } from './retention.mjs';
const DAY = 86400_000;
const MAX_ROWS = 3000;
const summaryKey = day => `trend/${day}`;
const tuple = row => [Date.parse(row.captured_at), row.status === 'ok' ? row.value_c : null, row.status, Date.parse(row.recorded_at)];
export function validDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day || '') && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day;
}

// A compact daily index avoids reading ~1440 separate history blobs every minute.
// UUID keys make retries idempotent; compare-and-swap protects concurrent uploads.
export async function mergeTrend(store, day, records, complete = false) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const previous = await store.getWithMetadata(summaryKey(day), { type:'json', consistency:'strong' });
    const data = previous?.data || { version:1, day, complete:false, rows:{} };
    const rows = { ...data.rows };
    for (const record of records) rows[record.id] = tuple(record);
    const next = { version:1, day, complete:data.complete || complete, rows };
    const result = await store.setJSON(summaryKey(day), next, previous ? {onlyIfMatch:previous.etag} : {onlyIfNew:true});
    if (result.modified) return next;
  }
  throw Error('Trend update conflict; retry upload');
}
export async function updateTrend(store, record) {
  return mergeTrend(store, dayKST(record.captured_at), [record]);
}
async function readDay(store, day) {
  const indexed = await store.get(summaryKey(day), {type:'json',consistency:'strong'});
  if (indexed?.complete) return indexed;
  // Upgrade old history once, and merge with uploads that arrived during scanning.
  const keys = [];
  for await (const page of store.list({prefix:`records/${day}/`,paginate:true})) {
    keys.push(...page.blobs.map(blob=>blob.key));
    if (keys.length > MAX_ROWS) throw Error('Daily history limit exceeded');
  }
  const rows=[];
  for(let i=0;i<keys.length;i+=40) rows.push(...(await Promise.all(keys.slice(i,i+40).map(key=>store.get(key,{type:'json',consistency:'strong'})))).filter(Boolean));
  return mergeTrend(store,day,rows,true);
}
export function trendWindow({day,minutes=1,span=360}, now=Date.now()) {
  const today=dayKST(now);
  if(!validDay(day)||day>today||![1,5,10].includes(minutes)||![60,360,1440].includes(span)) return {error:'Invalid trend date / interval / span',status:400};
  if(day<oldestDay(now)) return {error:'30일 보관 기간이 지난 날짜입니다',status:410};
  const end=day===today?now:Date.parse(day+'T00:00:00+09:00')+DAY;
  const period=minutes*60000;
  const start=Math.max(Math.floor((end-span*60000)/period)*period,Date.parse(oldestDay(now)+'T00:00:00+09:00'));
  return {start,end,period};
}
export function aggregateTrend(entries,{start,end,period},now=Date.now()) {
  const bars=[];
  for(let at=start;at<end;at+=period) bars.push({time:new Date(at).toISOString(),open:null,high:null,low:null,close:null,count:0,invalid_count:0,complete:at+period<=now});
  entries.sort((a,b)=>a[1][0]-b[1][0]||a[1][3]-b[1][3]||a[0].localeCompare(b[0]));
  for(const [,row] of entries){
    const [time,value,status]=row;if(time<start||time>=end)continue;
    const bar=bars[Math.floor((time-start)/period)];
    if(status!=='ok'||!Number.isFinite(value)){bar.invalid_count++;continue;}
    if(!bar.count)bar.open=bar.high=bar.low=value;
    bar.high=Math.max(bar.high,value);bar.low=Math.min(bar.low,value);bar.close=value;bar.count++;
  }
  return bars;
}
export async function getTrend(store,options,now=Date.now()) {
  const window=trendWindow(options,now);if(window.error)return window;
  const days=[dayKST(window.start)];const lastDay=dayKST(window.end-1);if(lastDay!==days[0])days.push(lastDay);
  const summaries=await Promise.all(days.map(day=>readDay(store,day)));
  const bars=aggregateTrend(summaries.flatMap(summary=>Object.entries(summary.rows)),window,now);
  const valid=bars.filter(bar=>bar.count);
  return {day:options.day,minutes:options.minutes,span:options.span,timezone:'Asia/Seoul',server_now:new Date(now).toISOString(),
    start:new Date(window.start).toISOString(),end:new Date(window.end).toISOString(),oldest_day:oldestDay(now),bars,
    samples:valid.reduce((count,bar)=>count+bar.count,0),invalid_samples:bars.reduce((count,bar)=>count+bar.invalid_count,0),
    low:valid.length?Math.min(...valid.map(bar=>bar.low)):null,high:valid.length?Math.max(...valid.map(bar=>bar.high)):null};
}
