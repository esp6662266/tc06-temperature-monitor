// Display-only forecasts. Never write these values into measurement records.
export const MAX_ESTIMATE_MS = 120_000;
export const ESTIMATE_STATUSES = new Set(['ocr_failed', 'value_suspect', 'low_confidence', 'anchor_missing', 'ambiguous_anchor', 'occluded']);
const MINUTE = 60_000;
const median = values => {const sorted = [...values].sort((a,b)=>a-b), middle = Math.floor(sorted.length/2);return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;};
export const sortEntries = entries => [...entries].sort((a,b)=>a[1][0]-b[1][0] || a[1][3]-b[1][3] || a[0].localeCompare(b[0]));

export function estimateAt(entries, at, deviceId, expectedAnchorId) {
  if (!Number.isFinite(at) || !deviceId) return null;
  const normals = sortEntries(entries).filter(([,row])=>row[2]==='ok' && Number.isFinite(row[1]) && row[0]<=at && row[0]>=at-6*MINUTE);
  const newest = normals.at(-1);
  if (!newest || newest[1][4]!==deviceId || (expectedAnchorId && newest[0]!==expectedAnchorId)) return null;
  const age = at-newest[1][0];
  if (age<=0 || age>MAX_ESTIMATE_MS) return null;
  const selected = [newest];
  for (let i=normals.length-2; i>=0 && selected.length<5; i--) {
    const row = normals[i], gap = selected[0][1][0]-row[1][0];
    if (row[1][4]!==deviceId || gap<30_000 || gap>90_000) break;
    selected.unshift(row);
  }
  if (selected.length<3) return null;
  const slopes = selected.slice(1).map((row,i)=>(row[1][1]-selected[i][1][1])*MINUTE/(row[1][0]-selected[i][1][0]));
  const slope = median(slopes), tolerance = Math.max(.5,Math.abs(slope)*.2);
  if (slopes.some(value=>Math.abs(value-slope)>tolerance)) return null;
  const value = Math.round((newest[1][1]+slope*age/MINUTE)*10)/10;
  if (!Number.isFinite(value) || Math.abs(value)>9999.9) return null;
  return {estimated:true,method:'recent_linear_v1',value_c:value,estimated_at:new Date(at).toISOString(),
    based_on_at:new Date(newest[1][0]).toISOString(),based_on_value_c:newest[1][1],last_normal_id:newest[0],
    expires_at:new Date(newest[1][0]+MAX_ESTIMATE_MS).toISOString(),sample_count:selected.length,slope_c_per_minute:slope,device_id:deviceId};
}

export function estimateFailures(entries, {start,end}) {
  const sorted = sortEntries(entries), result=[];
  // At most five normals are needed; processing is linear in daily history size.
  let recent=[];
  for (const [id,row] of sorted) {
    if (row[0]>=end) break;
    if (row[2]==='ok') {recent.push([id,row]);recent=recent.slice(-5);continue;}
    if (row[0]<start || !ESTIMATE_STATUSES.has(row[2])) continue;
    const estimate=estimateAt(recent,row[0],row[4]);
    if (estimate) result.push({...estimate,source_record_id:id,source_status:row[2]});
  }
  return result;
}
