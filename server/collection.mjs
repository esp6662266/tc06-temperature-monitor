export const DEFAULT_COLLECTION = Object.freeze({interval_seconds:60,revision:0,updated_at:null});
const KEY='settings/collection';
export const validInterval = value => Number.isSafeInteger(value)&&value>=30&&value<=3600;

export function collectionSettings(getStore) {
  let cached=null,expires=0;
  const read=async(force=false)=>{
    if(!force&&cached&&Date.now()<expires)return cached;
    const saved=await getStore().get(KEY,{type:'json',consistency:'strong'});
    cached=saved||{...DEFAULT_COLLECTION};expires=Date.now()+60_000;
    return cached;
  };
  const save=async input=>{
    if(!validInterval(input?.interval_seconds)||!Number.isSafeInteger(input?.revision)||input.revision<0)
      return {error:'기록 간격은 30~3600초 사이의 정수로 입력하세요',status:400};
    const store=getStore(),previous=await store.getWithMetadata(KEY,{type:'json',consistency:'strong'});
    if((previous?.data.revision||0)!==input.revision)return {error:'다른 화면에서 설정이 변경됐습니다. 설정을 다시 불러오세요',status:409};
    const value={interval_seconds:input.interval_seconds,revision:input.revision+1,updated_at:new Date().toISOString()};
    const result=await store.setJSON(KEY,value,previous?{onlyIfMatch:previous.etag}:{onlyIfNew:true});
    if(!result.modified)return {error:'설정이 동시에 변경됐습니다. 설정을 다시 불러오세요',status:409};
    cached=value;expires=Date.now()+60_000;return value;
  };
  return {read,save};
}
