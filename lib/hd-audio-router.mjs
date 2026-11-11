import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

const RATE = 48000, BLOCK = 960, HD_PREFILL = 76800, RECOVERY_MS = 2000, HD_STARVE_GRACE_MS = 250;

class AudioQueue {
  constructor(maxFrames) { this.maxFrames = maxFrames; this.clear(); }
  clear() { this.chunks = []; this.offset = 0; this.frames = 0; }
  push(samples, mono = false) {
    if (!samples.length) return;
    let stereo = samples;
    if (mono) { stereo = new Float32Array(samples.length * 2); for (let i = 0; i < samples.length; i++) stereo[i * 2] = stereo[i * 2 + 1] = samples[i]; }
    this.chunks.push(stereo); this.frames += stereo.length / 2; this.trim(this.maxFrames);
  }
  trim(keep) {
    let drop = Math.max(0, this.frames - keep);
    while (drop > 0 && this.chunks.length) {
      const available = (this.chunks[0].length - this.offset) / 2, consume = Math.min(available, drop);
      this.offset += consume * 2; this.frames -= consume; drop -= consume;
      if (this.offset === this.chunks[0].length) { this.chunks.shift(); this.offset = 0; }
    }
  }
  read(frames) {
    const output = new Float32Array(frames * 2); let position = 0;
    while (position < output.length && this.chunks.length) {
      const chunk = this.chunks[0], count = Math.min(chunk.length - this.offset, output.length - position);
      output.set(chunk.subarray(this.offset, this.offset + count), position);
      position += count; this.offset += count; this.frames -= count / 2;
      if (this.offset === chunk.length) { this.chunks.shift(); this.offset = 0; }
    }
    return output;
  }
}

// Keep audio in bounded queues and send it at playback speed. Native HD PCM
// arrives in bursts; queue coverage is a better loss signal than PCM arrival
// alone. A short sync debounce and stable recovery period prevent flapping.
export class HdAudioRouter extends EventEmitter {
  constructor({ fallback = true, fm = true, now = () => performance.now() } = {}) {
    super(); this.hd = new AudioQueue(RATE * 4); this.fm = new AudioQueue(RATE / 4);
    this.now = now; this.fallback = fallback; this.fmAvailable = fm; this.synced = false; this.source = 'none'; this.revision = 0;
    this.reason = 'Waiting for receiver audio'; this.lastOutputAt = null; this.lastHdAt = 0; this.lastFmAt = 0;
    this.recoverySince = null; this.lostSyncSince = null; this.hdStarvedSince = null; this.lastSample = [0, 0]; this.fade = 0;
    this.underflows = 0; this.maxTickDelayMs = 0; this.hdInputFrames = 0; this.fmInputFrames = 0;
  }
  snapshot() { return { audioSource: this.source, audioReason: this.reason, outputRevision: this.revision, lastOutputAt: this.lastOutputAt }; }
  diagnostics() { return { hdBufferedMs: this.hd.frames / 48, fmBufferedMs: this.fm.frames / 48, audioUnderflows: this.underflows, sourceSwitches: this.revision, maxTickDelayMs: this.maxTickDelayMs, hdInputFrames: this.hdInputFrames, fmInputFrames: this.fmInputFrames }; }
  start() { this.nextAt = this.now() + 20; this.timer = setInterval(() => this.tick(), 10); }
  stop() { clearInterval(this.timer); this.timer = null; this.hd.clear(); this.fm.clear(); this.source = 'none'; this.lastOutputAt = null; }
  resetHd() { this.hd.clear(); this.recoverySince = null; this.lastHdAt = 0; this.hdStarvedSince = null; }
  setSync(value) {
    const now = this.now();
    if (!value && this.synced) this.lostSyncSince = now;
    if (value) this.lostSyncSince = null;
    this.synced = Boolean(value);
    if (!value) { this.recoverySince = null; if (this.source !== 'hd') this.resetHd(); }
  }
  decoderFailed() { this.setSync(false); this.lostSyncSince = this.now() - 1000; this.resetHd(); this.choose(this.now()); }
  pushHd(samples) {
    if (!this.synced) return;
    const now = this.now();
    if (this.lastHdAt && now - this.lastHdAt > 1800) { this.hd.clear(); this.recoverySince = null; }
    this.lastHdAt = now; this.recoverySince ??= now; this.hdInputFrames += samples.length / 2; this.hd.push(samples);
  }
  pushFm(samples) { this.fmInputFrames += samples.length; this.fm.push(samples, true); this.lastFmAt = this.now(); }
  select(source, reason) {
    this.reason = reason;
    if (source === this.source) return;
    if (source === 'hd') this.hd.trim(HD_PREFILL);
    if (source === 'fm') this.fm.trim(RATE / 8);
    this.source = source; this.revision++; this.fade = 2880; this.fadeFrom = [...this.lastSample];
    this.emit('source', this.snapshot());
  }
  choose(now) {
    const syncLost = !this.synced && (this.lostSyncSince === null || now - this.lostSyncSince >= 250);
    const hdPlaying = this.source === 'hd' && !syncLost && this.hd.frames >= BLOCK;
    const recovered = this.synced && this.hd.frames >= HD_PREFILL && this.recoverySince !== null && now - this.recoverySince >= RECOVERY_MS && now - this.lastHdAt <= 1800;
    if (hdPlaying || recovered) { this.hdStarvedSince = null; this.select('hd', 'HD digital audio'); return; }
    if (this.source === 'hd') {
      if (this.hd.frames < BLOCK) {
        if (this.hdStarvedSince === null) { this.hdStarvedSince = now; this.underflows++; }
        if (!syncLost && now - this.hdStarvedSince < HD_STARVE_GRACE_MS) {
          this.reason = 'Holding HD audio through a brief decoder gap';
          return;
        }
      }
      this.resetHd();
    }
    const fmFresh = this.fmAvailable && this.fm.frames >= (this.source === 'fm' ? BLOCK : RATE / 8) && now - this.lastFmAt < 750;
    if (this.fallback && fmFresh) this.select('fm', this.synced ? 'HD audio unavailable · FM main program' : 'HD signal unavailable · FM main program');
    else this.select('none', this.fallback ? 'Waiting for receiver audio' : 'Waiting for HD audio · FM fallback off');
  }
  tick() {
    const now = this.now(); if (now < this.nextAt) return;
    this.maxTickDelayMs = Math.max(this.maxTickDelayMs, now - this.nextAt);
    // Do not emit a burst after a stalled event loop. Rejoin live playback.
    if (now - this.nextAt > 100) { this.nextAt = now; this.fm.trim(RATE / 8); this.hd.trim(HD_PREFILL); }
    let blocks = 0;
    while (now >= this.nextAt && blocks++ < 5) {
      this.nextAt += 20; this.choose(now);
      if (this.source === 'none' && !this.fade) continue;
      const samples = this.source === 'hd' ? this.hd.read(BLOCK) : this.source === 'fm' ? this.fm.read(BLOCK) : new Float32Array(BLOCK * 2);
      let power = 0;
      for (let i = 0; i < BLOCK; i++) {
        const blend = this.fade ? 1 - this.fade-- / 2880 : 1;
        for (let c = 0; c < 2; c++) {
          const index = i * 2 + c;
          if (blend < 1) samples[index] = this.fadeFrom[c] * (1 - blend) + samples[index] * blend;
          power += samples[index] * samples[index];
        }
      }
      this.lastSample = [samples[samples.length - 2], samples[samples.length - 1]];
      this.lastOutputAt = Date.now(); this.emit('audio', { samples, level: Math.sqrt(power / samples.length), source: this.source });
    }
  }
}
