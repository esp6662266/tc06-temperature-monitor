import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import '../web/voice.js';
const {temperatureTokens,keys}=globalThis.TC06Voice;
test('Korean temperature number composition covers hundreds, decimals, negatives and zero',()=>{
 const cases=[
  [0,['intro','0','end']],[-0,['intro','0','end']],
  [38,['intro','3','10','8','end']],
  [100,['intro','100','end']],
  [123.4,['intro','100','2','10','3','point','4','end']],
  [350,['intro','3','100','5','10','end']],
  [600,['intro','6','100','end']],
  [999.9,['intro','9','100','9','10','9','point','9','end']],
  [-12.3,['intro','minus','10','2','point','3','end']],
  [1000,['intro','1000','end']],
  [9999.9,['intro','9','1000','9','100','9','10','9','point','9','end']]
 ];
 for(const [value,expected]of cases)assert.deepEqual(temperatureTokens(value),expected);
 for(const bad of [NaN,Infinity,10000,'38'])assert.throws(()=>temperatureTokens(bad));
});
test('all fixed MP3 fragments exist, match manifest and remain below 100 KB total',async()=>{
 const manifest=JSON.parse(await readFile('web/voice/manifest.json','utf8'));assert.deepEqual(Object.keys(manifest.words).sort(),[...keys].sort());
 let bytes=0;for(const key of keys){const file=await readFile(`web/voice/${key}.mp3`);assert.ok(file.length>100);bytes+=file.length;}
 assert.equal(bytes,manifest.bytes);assert.ok(bytes<100000);assert.equal(manifest.gender,'female');
});
