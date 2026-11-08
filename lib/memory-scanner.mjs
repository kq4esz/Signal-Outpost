import { DIGITAL_MODES, digitalScanProfile } from './channel-protocols.mjs';

const DSD_NEO_SCAN_MODES = new Set([...DIGITAL_MODES, 'AM', 'NFM', 'WFM']);

export function scanPlan(channels, body = {}) {
  const explicit = body.channelIds !== undefined;
  if (explicit && (!Array.isArray(body.channelIds) || !body.channelIds.length)) throw new Error('Select at least one memory channel to scan.');
  const ids = explicit ? [...new Set(body.channelIds)] : channels.filter(channel => channel.enabled !== false && channel.kind !== 'trunked' && channel.mode !== 'HD' && !DIGITAL_MODES.has(channel.mode)).map(channel => channel.id);
  if (!ids.length) throw new Error('Add or select at least one conventional memory channel.');
  if (ids.length > 256) throw new Error('Scan up to 256 selected memories at a time.');
  const selected = ids.map(id => {
    const channel = channels.find(item => item.id === id);
    if (!channel) throw new Error('A selected memory no longer exists. Refresh the library and select again.');
    if (channel.kind === 'trunked') throw new Error('Rapid scan uses conventional frequencies. Open a trunked system in Decoders to follow its control channel and talkgroups.');
    if (channel.enabled === false) throw new Error(`Enable “${channel.name}” before scanning it.`);
    if (channel.mode === 'HD') throw new Error('HD Radio needs time to acquire its digital signal. Tune HD memories individually; exclude them from rapid scans.');
    return channel;
  });
  const digital = selected.filter(channel => DIGITAL_MODES.has(channel.mode));
  const analog = selected.filter(channel => !DIGITAL_MODES.has(channel.mode));
  const rapid = body.rapid === true;
  const requested = Number(body.dwellMs ?? (rapid ? 150 : 1500));
  if (!Number.isFinite(requested)) throw new Error('Choose a valid scan dwell time.');
  const dsdNeoCompatible = selected.every(channel => DSD_NEO_SCAN_MODES.has(channel.mode));
  const usesDsdNeoAnalog = selected.some(channel => ['AM', 'NFM', 'WFM'].includes(channel.mode));
  const engine = dsdNeoCompatible && usesDsdNeoAnalog ? 'dsd' : digital.length && analog.length ? 'hybrid' : digital.length ? 'digital' : 'native';
  const minimumDwell = engine === 'dsd' ? 0 : engine === 'hybrid' ? 500 : rapid ? 80 : 500;
  return { channels: selected, channelIds: ids, engine, profile: engine === 'digital' ? digitalScanProfile(selected) : null,
    rapid, dwellMs: Math.round(Math.max(minimumDwell, Math.min(15000, requested))),
    holdOnSignal: body.holdOnSignal !== false, holdMs: Math.max(250, Math.min(10000, Number(body.holdMs) || 1500)), thresholdDb: Math.max(3, Math.min(30, Number(body.thresholdDb) || 8)) };
}

export function spectrumSnr(bins, sampleRate, mode) {
  const bandwidth = { AM: 10000, NFM: 12500, WFM: 160000, USB: 5000, LSB: 5000, CW: 2500 }[mode] || 12500;
  const center = bins.length / 2, width = Math.max(2, Math.ceil(bandwidth / sampleRate * bins.length / 2));
  // A Hann-windowed RTL spectrum leaks a strong center/DC spur into its two
  // neighboring bins. Ignore those bins for voice modes so the spur cannot
  // masquerade as a real channel signal.
  const centerGuard = mode === 'CW' ? 0 : 1;
  const signal = [], noise = [];
  for (let i = 0; i < bins.length; i++) {
    const distance = Math.abs(i - center);
    if (distance > centerGuard && distance <= width) signal.push(bins[i]);
    if (distance >= width * 2 && distance <= Math.max(width * 6, 20)) noise.push(bins[i]);
  }
  if (!signal.length || !noise.length) return 0;
  noise.sort((a, b) => a - b);
  const noiseFloor = noise[Math.floor(noise.length / 2)];
  const occupancyRise = mode === 'WFM' ? 8 : mode === 'CW' ? 8 : 5;
  const activeBins = signal.filter(level => level >= noiseFloor + occupancyRise).sort((a, b) => b - a);
  const requiredBins = Math.min(signal.length, mode === 'WFM' ? 6 : mode === 'CW' ? 3 : 3);
  // A single tall FFT bin is usually a spur or random noise. Require energy
  // across several bins before treating the channel as occupied.
  if (activeBins.length < requiredBins) return 0;
  return activeBins.slice(0, requiredBins).reduce((a, b) => a + b, 0) / requiredBins - noiseFloor;
}

/** One serial tuning loop; stopping invalidates both queued timers and in-flight results. */
export class MemoryScanner {
  constructor(plan, { tune, event = () => {}, error = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { plan, tune, event, error, now, schedule, cancel });
    this.active = false; this.index = -1; this.hops = 0; this.holding = false; this.paused = false; this.startedAt = 0; this.hits = 0; this.epoch = 0;
  }
  snapshot() { return { active: this.active, engine: this.plan.engine || 'native', rapid: this.plan.rapid, dwellMs: this.plan.dwellMs, channelIds: this.plan.channelIds, channelCount: this.plan.channels.length, holding: this.holding, paused: this.paused, signalDb: Number.isFinite(this.signalDb) ? Number(this.signalDb.toFixed(1)) : null, channel: this.current || null, hops: this.hops }; }
  async start() { this.active = true; await this.advance(); if (this.failure) throw this.failure; return this.snapshot(); }
  stop() { this.active = false; this.epoch++; if (this.timer !== undefined) this.cancel(this.timer); this.timer = undefined; }
  pause() {
    if (!this.active || this.paused) return this.snapshot();
    this.paused = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.event('scan', this.snapshot());
    return this.snapshot();
  }
  async resume() {
    if (!this.active || !this.paused) return this.snapshot();
    this.paused = false;
    this.event('scan', this.snapshot());
    if (!this.busy) {
      if (this.holding) this.checkHold();
      else await this.advance();
    }
    return this.snapshot();
  }
  async advance(force = false) {
    if (!this.active || (this.paused && !force) || this.busy) return;
    this.busy = true; const epoch = this.epoch;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.holding = false; this.hits = 0; this.signalDb = null;
    const channel = this.plan.channels[(this.index + 1) % this.plan.channels.length];
    try {
      await this.tune(channel);
      if (!this.active || epoch !== this.epoch) return;
      this.index = (this.index + 1) % this.plan.channels.length;
      this.current = channel; this.startedAt = this.now(); this.hops++;
      this.event('scan', this.snapshot());
      if (!this.paused) this.timer = this.schedule(() => this.advance(), this.plan.dwellMs);
    } catch (error) { this.failure = error; this.stop(); this.error(error); }
    finally { this.busy = false; }
  }
  observe(snr) {
    if (!this.active || this.busy || !this.current || !this.plan.holdOnSignal || this.now() - this.startedAt < 40) return;
    this.signalDb = Number.isFinite(snr) ? snr : null;
    const strong = snr >= this.plan.thresholdDb;
    this.hits = strong ? this.hits + 1 : 0;
    if (strong && this.holding) this.lastSignalAt = this.now();
    const singleFrameLock = this.plan.dwellMs < 140 && snr >= this.plan.thresholdDb + 8;
    if (!this.holding && (this.hits >= 2 || (this.hits === 1 && singleFrameLock))) this.holdOnActivity();
  }
  observeActivity(active) {
    if (!this.active || this.busy || !active || !this.current || !this.plan.holdOnSignal || this.now() - this.startedAt < 40) return;
    if (this.holding) { this.lastSignalAt = this.now(); return; }
    this.holdOnActivity();
  }
  holdOnActivity() {
    this.holding = true; this.lastSignalAt = this.now();
    if (this.timer !== undefined) this.cancel(this.timer);
    this.event('scan-hold', this.snapshot());
    if (!this.paused) this.checkHold();
  }
  checkHold() {
    if (!this.active || this.paused || !this.holding) return;
    const remaining = this.plan.holdMs - (this.now() - this.lastSignalAt);
    this.timer = this.schedule(() => remaining <= 0 ? this.advance() : this.checkHold(), Math.max(25, Math.min(100, remaining)));
  }
  skip() { if (!this.active) return; if (this.timer !== undefined) this.cancel(this.timer); return this.advance(this.paused); }
}
