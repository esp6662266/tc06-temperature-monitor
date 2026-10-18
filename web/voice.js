'use strict';
// Fixed Korean female recordings, composed in Web Audio. No OS speech voices,
// external TTS service, per-temperature audio file or uploaded speech is used.
(() => {
  const KEYS = ['intro','fallback','minus','0','1','2','3','4','5','6','7','8','9','10','100','1000','point','end'];
  function temperatureTokens(value, kind = 'good') {
    if (!Number.isFinite(value) || Math.abs(value) > 9999.9) throw Error('온도 범위를 확인하세요');
    const tenths = Math.round(Math.abs(value) * 10);
    let integer = Math.floor(tenths / 10);
    const tokens = [kind === 'fallback' ? 'fallback' : 'intro'];
    if (value < 0 && tenths) tokens.push('minus');
    if (!integer) tokens.push('0');
    for (const place of [1000,100,10,1]) {
      const digit = Math.floor(integer / place); integer %= place;
      if (!digit) continue;
      if (digit !== 1 || place === 1) tokens.push(String(digit));
      if (place > 1) tokens.push(String(place));
    }
    if (tenths % 10) tokens.push('point', String(tenths % 10));
    tokens.push('end');
    return tokens;
  }
  class NumberVoice {
    constructor() {
      this.context = null; this.gain = null; this.bytes = new Map(); this.buffers = new Map();
      this.sources = []; this.generation = 0; this.loading = null; this.decoding = null;
      this.playing = false; this.lastTokens = []; this.lastValue = null; this.playedCount = 0;
    }
    preload() {
      if (this.bytes.size === KEYS.length) return Promise.resolve();
      if (this.loading) return this.loading;
      this.loading = Promise.all(KEYS.map(async key => {
        const response = await fetch(`/voice/${key}.mp3`);
        if (!response.ok) throw Error('숫자 음성 묶음을 불러올 수 없습니다. 온라인으로 한 번 접속해 주세요.');
        this.bytes.set(key, await response.arrayBuffer());
      })).then(() => {}).finally(() => { this.loading = null; });
      return this.loading;
    }
    async unlock(volume = 0.8) {
      if (!this.context) {
        const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Audio) throw Error('이 브라우저는 웹 숫자 TTS를 지원하지 않습니다.');
        this.context = new Audio(); this.gain = this.context.createGain(); this.gain.connect(this.context.destination);
      }
      this.setVolume(volume);
      // Called directly from the click before network work, preserving activation.
      const resumed = this.context.resume();
      await Promise.all([resumed, this.preload()]);
      if (this.context.state !== 'running') throw Error('음성 시작을 다시 눌러 소리 재생을 허용해 주세요.');
      if (this.buffers.size !== KEYS.length) {
        if (!this.decoding) this.decoding = Promise.all(KEYS.map(key => new Promise((resolve,reject) => {
          this.context.decodeAudioData(this.bytes.get(key).slice(0), buffer => { this.buffers.set(key,buffer); resolve(); }, reject);
        }))).finally(() => { this.decoding = null; });
        await this.decoding;
      }
    }
    setVolume(value) { if (this.gain) this.gain.gain.value = Math.max(0,Math.min(1,value)); }
    cancel() {
      this.generation++; this.playing = false;
      for (const source of this.sources) { try { source.stop(); source.disconnect(); } catch {} }
      this.sources = [];
    }
    async say(value, volume = 0.8, kind = 'good') {
      this.cancel(); const generation = this.generation;
      const tokens = temperatureTokens(value, kind);
      await this.unlock(volume);
      if (generation !== this.generation) return false;
      let at = this.context.currentTime + 0.06;
      this.lastTokens = tokens; this.lastValue = value; this.playedCount++; this.playing = true;
      for (const token of tokens) {
        const source = this.context.createBufferSource(); source.buffer = this.buffers.get(token);
        source.connect(this.gain); source.start(at); this.sources.push(source); at += source.buffer.duration;
      }
      const last = this.sources[this.sources.length-1];
      last.onended = () => { if (generation === this.generation) { this.playing = false; for (const source of this.sources) source.disconnect(); this.sources = []; } };
      return true;
    }
  }
  globalThis.TC06Voice = { NumberVoice, temperatureTokens, keys: KEYS };
})();
