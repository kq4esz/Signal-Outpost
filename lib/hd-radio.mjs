import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { UsbReceiver } from './rtl-usb.mjs';
import { hdBandForFrequency, hdProgram } from './hd-options.mjs';
import { RF_WINDOW_BYTES, spectrumFromCu8 } from './rf-spectrum.mjs';
import { HdAudioRouter } from './hd-audio-router.mjs';
import { HdReceiverMetrics } from './hd-receiver-metrics.mjs';
import { hdGainRecommendation } from './hd-gain.mjs';
import { guardDecoderProcess } from './native-process.mjs';

const native = fileURLToPath(new URL('../native/hd-radio/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(native, 'manifest.json'), 'utf8'));
const PLATFORM = `${process.platform}-${process.arch}`;
const runtime = manifest.runtimes?.[PLATFORM] || null;
const worker = fileURLToPath(new URL('./hd-radio-worker.mjs', import.meta.url));
const RATE = 1488375;
export function hdRuntime() {
  return { name: manifest.name, version: manifest.version, source: manifest.source,
    available: Boolean(runtime?.sha256 && runtime.library && fs.existsSync(path.join(native, runtime.library))) };
}

// Reject arbitrary broadcast file formats and oversized image dimensions.
function imageMime(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    return w > 0 && h > 0 && w <= 4096 && h <= 4096 ? 'image/png' : null;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if ([0xd8, 0xd9, 0x01].includes(marker) || marker >= 0xd0 && marker <= 0xd7) continue;
    if (marker === 0xda || offset + 2 > bytes.length) break;
    const size = bytes.readUInt16BE(offset); if (size < 2 || offset + size > bytes.length) break;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      const h = bytes.readUInt16BE(offset + 3), w = bytes.readUInt16BE(offset + 5);
      return w > 0 && h > 0 && w <= 4096 && h <= 4096 ? 'image/jpeg' : null;
    }
    offset += size;
  }
  return null;
}

// Keep both stereo channels and the fractional position between 44.1 kHz
// native PCM blocks. The browser's shared audio output runs at 48 kHz.
class StereoAudio {
  constructor() { this.previous = null; this.position = 0; }
  push(bytes) {
    const count = bytes.length / 4, prefix = this.previous ? 1 : 0;
    const input = new Float32Array((count + prefix) * 2);
    if (prefix) input.set(this.previous);
    for (let i = 0; i < count * 2; i++) input[i + prefix * 2] = bytes.readInt16LE(i * 2) / 32768;
    const output = new Float32Array(Math.ceil((count + 1) * 48000 / 44100) * 2);
    let length = 0, power = 0;
    while (this.position < count + prefix - 1) {
      const a = Math.floor(this.position), blend = this.position - a;
      for (let c = 0; c < 2; c++) {
        const sample = input[a * 2 + c] * (1 - blend) + input[(a + 1) * 2 + c] * blend;
        output[length++] = sample; power += sample * sample;
      }
      this.position += 44100 / 48000;
    }
    this.position -= Math.max(0, count + prefix - 1);
    this.previous = input.slice(-2);
    return { samples: output.subarray(0, length), level: length ? Math.sqrt(power / length) : 0 };
  }
}

export class HdRadio extends EventEmitter {
  constructor({ frequency, program = 0, settings }) {
    super();
    this.frequency = Math.round(Number(frequency)); this.band = hdBandForFrequency(this.frequency); this.program = hdProgram(program); this.settings = settings;
    this.phase = 'idle'; this.synced = false; this.station = {}; this.programs = new Map(); this.images = new Map(); this.ports = new Map();
    this.sessionId = randomBytes(8).toString('hex'); this.lastError = ''; this.lastAudioAt = null; this.audio = new StereoAudio();
    this.audioBuffer = Buffer.alloc(0); this.rfBuffer = Buffer.alloc(0); this.stopping = false; this.lastBroadcast = 0;
    this.fallbackEnabled = settings.hdFmFallback !== false; this.decoderReady = false;
    this.receiverMetrics = new HdReceiverMetrics();
    this.autoGain = !Number(settings.tunerGain); this.gainGeneration = 0; this.gainAdjustments = 0;
    this.router = new HdAudioRouter({ fallback: this.fallbackEnabled && this.band === 'FM', fm: false });
    this.router.on('audio', audio => this.emit('audio', audio));
    this.router.on('source', () => { if (this.router.source === 'hd') this.decoderRetries = 0; this.changed(true); });
  }
  get active() { return ['starting', 'listening'].includes(this.phase); }
  snapshot() {
    const services = [...this.programs.values()].sort((a, b) => a.program - b.program).map(item => ({ ...item, ...this.artworkFor(item) }));
    return { phase: this.phase, active: this.active, frequency: this.frequency, band: this.band, program: this.program,
      synced: this.synced, station: this.station, services, selected: services.find(item => item.program === this.program) || { program: this.program },
      mer: this.mer || null, ber: this.ber ?? null, frequencyOffset: this.frequencyOffset ?? null, lastAudioAt: this.lastAudioAt,
      ...this.router.snapshot(), fallbackEnabled: this.fallbackEnabled, fallbackAvailable: this.band === 'FM' && Boolean(this.fmWorker),
      fallbackError: this.fmError || '', decoderError: this.decoderError || '', decoderReady: this.decoderReady,
      diagnostics: { ...this.receiverMetrics.value, ...this.router.diagnostics(), native: this.nativeMetrics || null, nativeBacklogBytes: this.child?.stdin.writableLength || 0, fmBacklogBytes: this.fmPending || 0 },
      gainMode: this.autoGain ? 'auto' : 'manual', gainAdjustments: this.gainAdjustments,
      sampleRate: RATE, info: this.usb?.info || null, lastError: this.lastError, runtime: hdRuntime(), sessionId: this.sessionId };
  }
  changed(force = false) {
    if (this.stopping) return;
    if (force || Date.now() - this.lastBroadcast > 250) { this.lastBroadcast = Date.now(); this.emit('state', this.snapshot()); }
    else if (!this.stateTimer) this.stateTimer = setTimeout(() => { this.stateTimer = null; this.changed(true); }, 260);
  }
  service(program, fields = {}) {
    if (!Number.isInteger(program) || program < 0 || program > 7) return;
    this.programs.set(program, { ...this.programs.get(program), program, ...fields });
  }
  artworkFor(track) {
    const files = [...this.images.values()].filter(image => image.program === track.program);
    const reference = track.xhdr;
    const exact = reference?.lot >= 0 && reference.param >= 0 ? files.find(image => image.lot === reference.lot) : null;
    const image = exact || files.findLast(image => image.role === 'logo');
    if (!image) return { artwork: null, artworkKind: null };
    const logo = image.role === 'logo' || exact && reference.mime === 0xd9c72536;
    return { artwork: `/api/hd/art/${this.sessionId}/${image.id}`, artworkKind: logo ? 'logo' : 'art' };
  }
  metadata(message) {
    if (this.stopping) return;
    if (message.type === 'fatal') { this.decoderFailure(this.child, new Error(message.error)); return; }
    if (message.type === 'sync') { this.synced = message.synced; this.router.setSync(message.synced); this.frequencyOffset = message.freq_offset ?? null; if (!message.synced) { this.lastAudioAt = null; this.audio = new StereoAudio(); } }
    else if (message.type === 'metrics') this.nativeMetrics = message.metrics;
    else if (message.type === 'mer') this.mer = { lower: message.lower, upper: message.upper };
    else if (message.type === 'ber') this.ber = message.ber;
    else if (message.type === 'station') { const { type, ...fields } = message; Object.assign(this.station, fields); }
    else if (message.type === 'id3') {
      const { type, program, ...fields } = message; this.service(program, fields);
    } else if (message.type === 'service') {
      const { type, program, genre: programGenre, ...fields } = message; this.service(program, { ...fields, programGenre, advertised: true });
    } else if (message.type === 'services') {
      this.ports.clear();
      for (const service of message.services) {
        const program = service.program;
        if (!Number.isInteger(program)) continue;
        this.service(program, { name: service.name, advertised: true });
        for (const component of service.components) if (component.kind === 'data') this.ports.set(component.port, { program, role: component.mime === 0xd9c72536 ? 'logo' : component.mime === 0xbe4b7536 ? 'art' : null });
      }
    } else if (message.type === 'lot') {
      const bytes = Buffer.from(message.data, 'base64'), mime = imageMime(bytes);
      if (!mime || bytes.length > 2 * 1024 * 1024) return;
      const association = this.ports.get(message.port);
      const program = message.service?.program ?? association?.program;
      if (!Number.isInteger(program) || program < 0 || program > 7) return;
      const id = createHash('sha256').update(bytes).update(`${message.port}:${message.lot}`).digest('hex').slice(0, 32);
      this.images.delete(id); this.images.set(id, { id, bytes, mime, program, port: message.port, lot: message.lot, role: association?.role });
      let total = [...this.images.values()].reduce((sum, image) => sum + image.bytes.length, 0);
      while (this.images.size > 48 || total > 16 * 1024 * 1024) { const [key, image] = this.images.entries().next().value; total -= image.bytes.length; this.images.delete(key); }
    } else return;
    this.changed();
  }
  selectProgram(value) {
    this.program = hdProgram(value); this.audio = new StereoAudio(); this.lastAudioAt = null;
    this.router.resetHd();
    if (this.child?.connected) this.child.send({ op: 'program', program: this.program });
    this.changed(true);
  }
  pcm(chunk) {
    this.audioBuffer = Buffer.concat([this.audioBuffer, chunk]);
    while (this.audioBuffer.length >= 12) {
      if (this.audioBuffer.toString('ascii', 0, 4) !== 'HDR5') { this.decoderFailure(this.child, new Error('Invalid HD audio frame.')); return; }
      const program = this.audioBuffer.readUInt32LE(4), size = this.audioBuffer.readUInt32LE(8);
      if (size > 65536 || size % 4 || program > 7) { this.decoderFailure(this.child, new Error('Invalid HD audio frame size.')); return; }
      if (this.audioBuffer.length < 12 + size) return;
      const bytes = this.audioBuffer.subarray(12, 12 + size); this.audioBuffer = this.audioBuffer.subarray(12 + size);
      if (program !== this.program || !this.active || this.stopping) continue;
      const audio = this.audio.push(bytes);
      this.lastAudioAt = Date.now(); this.service(program, { received: true }); this.router.pushHd(audio.samples); this.changed();
    }
  }
  iq(bytes) {
    if (!this.active || this.stopping) return;
    const metrics = this.receiverMetrics.push(bytes);
    if (metrics) void this.adjustAutoGain(metrics);
    if (this.fmWorker) {
      if (this.fmPending > 4 * 1024 * 1024) this.fmFailure(this.fmWorker, new Error('FM fallback cannot keep up with receiver samples.'));
      else {
        const copy = Uint8Array.from(bytes); this.fmPending += copy.byteLength;
        this.fmWorker.postMessage({ iq: copy.buffer }, [copy.buffer]);
      }
    }
    if (this.decoderReady && this.child) {
      if (this.child.stdin.destroyed || this.child.stdin.writableLength > 8 * 1024 * 1024) this.decoderFailure(this.child, new Error('The HD decoder fell behind the USB input.'));
      else this.child.stdin.write(bytes);
    }
    if (Date.now() - (this.lastRf || 0) < 80) return;
    const needed = RF_WINDOW_BYTES - this.rfBuffer.length;
    this.rfBuffer = Buffer.concat([this.rfBuffer, bytes.subarray(0, needed)]);
    if (this.rfBuffer.length < RF_WINDOW_BYTES) return;
    this.emit('spectrum', { type: 'spectrum', source: 'hd', bins: spectrumFromCu8(this.rfBuffer), center: this.frequency, tunedFrequency: this.frequency,
      span: RATE, timestamp: Date.now(), epoch: `hd:${this.sessionId}`, units: 'dBFS' });
    this.rfBuffer = Buffer.alloc(0); this.lastRf = Date.now();
  }
  startFm() {
    if (this.fmWorker || this.band !== 'FM' || !this.fallbackEnabled || this.stopping) return;
    this.fmError = ''; this.fmPending = 0;
    let worker;
    try { worker = new Worker(new URL('./hd-fm-worker.mjs', import.meta.url)); }
    catch (error) { this.fmError = error.message; this.router.fmAvailable = false; this.changed(true); return; }
    this.fmWorker = worker; this.router.fmAvailable = true;
    worker.on('message', message => {
      if (this.fmWorker !== worker || this.stopping) return;
      this.fmPending = Math.max(0, this.fmPending - message.consumed);
      this.router.pushFm(new Float32Array(message.samples, 0, message.length));
    });
    worker.on('error', error => this.fmFailure(worker, error));
    worker.on('exit', code => { if (this.fmWorker === worker && !this.stopping) this.fmFailure(worker, new Error(`FM fallback worker stopped (${code}).`)); });
  }
  async adjustAutoGain(metrics) {
    if (!this.autoGain || this.gainUpdating || !this.usb?.connected || this.stopping) return;
    // Hold a calibrated gain through normal peak variations. Recalibrate
    // only for overload or a large RF level change, avoiding gain pumping.
    if (this.gainCalibrated && metrics.clippingPercent <= 0.005 && metrics.amplitudeDbfs <= -2 && metrics.amplitudeDbfs >= -17) return;
    const next = hdGainRecommendation(metrics, this.usb.info.gain, this.usb.info.gains);
    if (next === this.usb.info.gain) { this.gainCalibrated = metrics.amplitudeDbfs <= -3 && metrics.amplitudeDbfs >= -12; return; }
    this.gainUpdating = true; const generation = this.gainGeneration;
    try {
      const applied = await this.usb.command('gain', { value: next, manual: true });
      if (this.stopping || generation !== this.gainGeneration) return;
      this.usb.info.gain = applied; this.gainAdjustments++; this.gainCalibrated = false; this.receiverMetrics.resetWindow(); this.changed(true);
    } catch (error) { if (!this.stopping) this.fail(error); }
    finally { this.gainUpdating = false; }
  }
  fmFailure(worker, error) {
    if (this.fmWorker !== worker || this.stopping) return;
    this.fmError = error.message; this.fmWorker = null; this.router.fmAvailable = false; this.router.fm.clear();
    void worker.terminate().catch(() => {}); this.changed(true);
  }
  async setFallback(enabled) {
    this.fallbackEnabled = Boolean(enabled); this.router.fallback = this.fallbackEnabled && this.band === 'FM';
    if (this.fallbackEnabled) this.startFm();
    else {
      const worker = this.fmWorker; this.fmWorker = null; this.router.fmAvailable = false; this.router.fm.clear();
      if (worker) await worker.terminate();
    }
    this.changed(true);
  }
  async retireDecoder(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (!child.stdin.destroyed) child.stdin.end();
    let timer;
    await Promise.race([child.hdExited, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await child.hdExited; }
  }
  decoderFailure(child, error) {
    if (!child || this.child !== child || this.stopping) return;
    this.decoderError = error.message; this.decoderReady = false; this.child = null; this.synced = false; this.lastAudioAt = null;
    this.audio = new StereoAudio(); this.audioBuffer = Buffer.alloc(0); this.router.decoderFailed();
    this.decoderClosing = this.retireDecoder(child); this.scheduleDecoderRetry(); this.changed(true);
  }
  scheduleDecoderRetry() {
    if (this.stopping || this.phase !== 'listening' || this.decoderRetry) return;
    const wait = Math.min(30000, 2000 * 2 ** Math.min(this.decoderRetries || 0, 4)); this.decoderRetries = (this.decoderRetries || 0) + 1;
    this.decoderRetry = setTimeout(async () => {
      this.decoderRetry = null;
      if (this.stopping) return;
      try { await this.startDecoder(); } catch (error) { this.decoderError = error.message; this.scheduleDecoderRetry(); this.changed(true); }
    }, wait);
  }
  async startDecoder() {
    await this.decoderClosing;
    if (this.stopping) throw new Error('HD Radio start cancelled.');
    this.router.resetHd(); this.audio = new StereoAudio(); this.audioBuffer = Buffer.alloc(0);
    this.programs.clear(); this.images.clear(); this.ports.clear();
    const env = { ...process.env };
    if ((process.platform === 'linux' || process.platform === 'darwin') && runtime.libraryDirectory) {
      const libraryDirectory = path.join(native, runtime.libraryDirectory);
      const variable = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
      env[variable] = [libraryDirectory, env[variable]].filter(Boolean).join(path.delimiter);
    }
    const child = spawn(process.execPath, [worker], { cwd: native, windowsHide: true, detached: process.platform === 'darwin', stdio: ['pipe','pipe','pipe','ipc'],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', SDREXTREME_HD_PROGRAM: String(this.program), SDREXTREME_HD_BAND: this.band, SDREXTREME_HD_FREQUENCY: String(this.frequency) } });
    this.child = child; child.hdExited = new Promise(resolve => child.once('close', resolve));
    child.once('spawn', () => {
      try { child.closeProcessGroup = guardDecoderProcess(child.pid); }
      catch (error) { this.decoderFailure(child, error); }
    });
    child.stdin.on('error', error => this.decoderFailure(child, error));
    child.stdout.on('data', chunk => { if (this.child === child) this.pcm(chunk); });
    child.stderr.on('data', chunk => { if (this.child === child) this.lastDiagnostic = chunk.toString().slice(-1500); });
    child.on('message', message => { if (this.child === child) this.metadata(message); });
    child.on('error', error => this.decoderFailure(child, error));
    child.on('close', () => { child.closeProcessGroup?.(); this.decoderFailure(child, new Error(this.decoderError || this.lastDiagnostic || 'The HD Radio decoder stopped.')); });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { const error = new Error('HD Radio decoder initialization timed out.'); this.decoderFailure(child, error); done(error); }, 12000);
      const onMessage = message => { if (message.type === 'ready') done(); else if (message.type === 'fatal') done(new Error(message.error)); };
      const onExit = () => done(new Error(this.decoderError || this.lastDiagnostic || 'HD Radio initialization failed.'));
      const done = error => { clearTimeout(timeout); child.off('message', onMessage); child.off('close', onExit); child.off('error', done); error ? reject(error) : resolve(); };
      child.on('message', onMessage); child.once('close', onExit); child.once('error', done);
    });
    if (this.stopping || this.child !== child) throw new Error('HD decoder start cancelled.');
    this.decoderReady = true; this.decoderError = ''; this.changed(true);
  }
  fail(error) {
    if (this.stopping || this.phase === 'failed') return;
    this.lastError = error.message; this.phase = 'failed'; this.emit('failure', error); void this.stop();
  }
  async start() {
    if (this.phase !== 'idle') throw new Error('This HD Radio session has already been used.');
    if (!hdRuntime().available) throw new Error('The bundled HD Radio decoder is unavailable for this platform.');
    if (Number(this.settings.directSampling)) throw new Error('HD Radio requires Quadrature sampling. Select it in Hardware settings; AM also requires a tuner with HF support such as Blog V4.');
    this.phase = 'starting'; this.changed(true);
    try {
      this.router.start(); this.startFm();
      if (this.stopping) throw new Error('HD Radio start cancelled.');
      this.usb = new UsbReceiver();
      this.usb.on('iq', bytes => this.iq(bytes));
      this.usb.on('failure', error => this.fail(error));
      this.usb.on('stopped', () => { if (!this.stopping) this.fail(new Error('The HD Radio USB receiver disconnected.')); });
      const info = await this.usb.start({ libraryPath: this.settings.rtlLibraryPath, deviceIndex: this.settings.deviceIndex, deviceSerial: this.settings.deviceSerial,
        frequency: this.frequency, sampleRate: RATE, gain: this.autoGain ? 0 : this.settings.tunerGain, manualGain: true, ppm: this.settings.ppm, rtlAgc: false,
        directSampling: 0, tunerBandwidth: 0, biasTee: this.settings.biasTee });
      if (this.stopping) throw new Error('HD Radio start cancelled.');
      this.receiverMetrics.resetWindow();
      if (Math.abs(info.sampleRate - RATE) > 20) throw new Error(`The USB driver returned ${info.sampleRate} SPS; HD Radio needs ${RATE} SPS.`);
      try { await this.startDecoder(); } catch (error) { if (this.stopping) throw error; this.decoderError = error.message; }
      this.phase = 'listening'; if (!this.decoderReady) this.scheduleDecoderRetry(); this.changed(true); return this.snapshot();
    } catch (error) {
      this.lastError = error.message; this.phase = 'failed'; await this.stop(); throw error;
    }
  }
  async gain(value) {
    this.gainGeneration++; this.autoGain = Number(value) === 0; this.gainCalibrated = false;
    const gain = await this.usb.command('gain', { value, manual: true });
    this.usb.info.gain = gain; this.receiverMetrics.resetWindow(); this.changed(true); return gain;
  }
  stop() { if (!this.stopPromise) this.stopPromise = this.close(); return this.stopPromise; }
  async close() {
    this.stopping = true; clearTimeout(this.stateTimer); clearTimeout(this.decoderRetry); this.router.stop();
    if (this.usb) await this.usb.close();
    const fm = this.fmWorker; this.fmWorker = null; if (fm) await fm.terminate();
    const child = this.child; this.child = null; await this.retireDecoder(child); await this.decoderClosing;
    this.decoderReady = false;
    this.phase = this.phase === 'failed' ? 'failed' : 'stopped'; this.synced = false; this.lastAudioAt = null;
    this.audioBuffer = Buffer.alloc(0); this.images.clear(); this.emit('state', this.snapshot());
  }
}
