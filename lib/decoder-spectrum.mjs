import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { sparseIqFile } from './native-process.mjs';
import { RF_WINDOW_BYTES, spectrumFromCu8 } from './rf-spectrum.mjs';

const KEEP_BYTES = 4 * 1024 * 1024;
const ALLOCATION_UNIT = 65536;
const RECORDING_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const RECORDING_COPY_CHUNK_BYTES = 256 * 1024;

export class DecoderSpectrum extends EventEmitter {
  constructor(folder, frequency) {
    super();
    this.filename = path.join(folder, 'live-rf.iq');
    this.metadataFile = this.filename + '.json';
    this.frequency = frequency;
    this.epoch = 0;
    this.session = Date.now();
    this.stopped = false;
    this.reclaimed = 0;
    this.previousSize = 0;
    this.previousEnd = 0;
    this.changedAt = 0;
    this.metadata = null;
    this.recording = null;
    this.lastRecording = null;
  }

  async prepare() {
    this.file = await fs.open(this.filename, 'wx+');
    try { this.sparse = sparseIqFile(this.filename, this.file.fd); }
    catch (error) { await this.close(); throw error; }
  }

  get args() { return ['--iq-capture', this.filename, '--iq-capture-format', 'cu8', '--iq-capture-max-mb', '0']; }

  get recordingState() {
    const recording = this.recording || this.lastRecording;
    return { active: Boolean(this.recording), fileName: recording?.fileName || null,
      bytes: recording?.bytes || 0, limitBytes: RECORDING_LIMIT_BYTES,
      sampleRateHz: Number(recording?.metadata?.sample_rate_hz) || 0,
      sizeLimitReached: Boolean(recording?.sizeLimitReached), error: recording?.error || null };
  }

  async startRecording(folder) {
    if (this.recording) throw new Error('An IQ recording is already running.');
    if (this.stopped) throw new Error('The decoder RF feed has stopped.');
    await this.work;
    const deadline = Date.now() + 8000;
    while (!this.metadata && !this.stopped && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (!this.metadata) throw new Error('The decoder IQ stream is not ready to record yet.');
    await fs.mkdir(folder, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
    const dataPath = path.join(folder, `decoder-${timestamp}.iq`);
    const metadataPath = `${dataPath}.json`;
    const dataFile = await fs.open(dataPath, 'wx+');
    let metadataFile = null, metadataCreated = false;
    try {
      const size = (await this.file.stat()).size;
      const sourceStart = Math.max(this.reclaimed, Math.floor(size / 2) * 2);
      const metadata = JSON.parse(JSON.stringify(this.metadata));
      const captureOffset = Number(metadata.capture_center_frequency_hz) - Number(metadata.center_frequency_hz);
      metadata.version = 1;
      metadata.sample_format = 'cu8';
      metadata.center_frequency_hz = this.frequency;
      metadata.capture_center_frequency_hz = this.frequency + (Number.isFinite(captureOffset) ? captureOffset : 0);
      metadata.capture_started_utc = new Date().toISOString();
      metadata.data_file = path.basename(dataPath);
      metadata.data_bytes = 0;
      metadata.capture_drops = 0;
      metadata.capture_drop_blocks = 0;
      metadata.input_ring_drops = 0;
      metadata.contains_retunes = false;
      metadata.capture_retune_count = 0;
      metadata.size_limit_reached = false;
      metadata.notes = '';
      delete metadata.events;
      const recording = { dataPath, metadataPath, file: dataFile, fileName: path.basename(dataPath),
        metadata, sourceStart, sourceEnd: sourceStart, bytes: 0, events: [], eventQueue: Promise.resolve(),
        lastUpdateAt: 0, sizeLimitReached: false, error: null };
      metadataFile = await fs.open(metadataPath, 'wx');
      metadataCreated = true;
      await metadataFile.writeFile(JSON.stringify(metadata, null, 2));
      await metadataFile.close(); metadataFile = null;
      this.recording = recording;
      this.lastRecording = recording;
      this.emit('recording', this.recordingState);
      return this.recordingState;
    } catch (error) {
      await metadataFile?.close().catch(() => {});
      await dataFile.close().catch(() => {});
      await fs.unlink(dataPath).catch(() => {});
      if (metadataCreated) await fs.unlink(metadataPath).catch(() => {});
      throw error;
    }
  }

  async stopRecording(options = {}) {
    if (this.recordingStopPromise) return this.recordingStopPromise;
    this.recordingStopping = true;
    this.recordingStopPromise = (async () => {
      if (this.work) await this.work;
      if (this.recording) {
        try { await this.copyRecording((await this.file.stat()).size); }
        catch (error) { return this.finishRecording({ ...options, error }); }
      }
      return this.finishRecording(options);
    })().finally(() => { this.recordingStopping = false; this.recordingStopPromise = null; });
    return this.recordingStopPromise;
  }

  async finishRecording({ sizeLimitReached = false, error = null } = {}) {
    const recording = this.recording;
    if (!recording) return this.recordingState;
    await recording.eventQueue;
    recording.sizeLimitReached ||= sizeLimitReached;
    recording.error ||= error ? String(error.message || error) : null;
    await recording.file.sync().catch(() => {});
    await recording.file.close().catch(() => {});
    const events = recording.events.map(event => ({ ...event, byte_offset: Math.min(recording.bytes, event.byte_offset) }));
    const metadata = { ...recording.metadata, data_bytes: recording.bytes,
      contains_retunes: events.length > 0, capture_retune_count: events.length,
      size_limit_reached: recording.sizeLimitReached,
      notes: recording.error || (recording.sizeLimitReached ? 'Recording stopped at the 2 GiB application limit.' : '') };
    if (events.length) { metadata.version = 2; metadata.events = events; }
    try { await fs.writeFile(recording.metadataPath, JSON.stringify(metadata, null, 2)); }
    catch (writeError) { recording.error ||= `Could not finalize IQ metadata: ${writeError.message}`; }
    this.recording = null;
    this.lastRecording = recording;
    this.emit('recording', this.recordingState);
    return this.recordingState;
  }

  recordRetune(frequency) {
    const recording = this.recording;
    if (!recording || this.recordingStopping) return;
    recording.eventQueue = recording.eventQueue.then(async () => {
      if (this.recording !== recording) return;
      const size = Math.floor((await this.file.stat()).size / 2) * 2;
      const captureOffset = Number(recording.metadata.capture_center_frequency_hz) - Number(recording.metadata.center_frequency_hz);
      recording.events.push({ kind: 'RETUNE', byte_offset: Math.min(RECORDING_LIMIT_BYTES, Math.max(0, size - recording.sourceStart)),
        center_frequency_hz: frequency, capture_center_frequency_hz: frequency + (Number.isFinite(captureOffset) ? captureOffset : 0),
        sample_rate_hz: Number(recording.metadata.sample_rate_hz), reason: 'Signal Outpost retune' });
    }).catch(error => { recording.error ||= error.message; });
  }

  tune(frequency) {
    if (!Number.isFinite(frequency) || frequency < 10000 || frequency === this.frequency) return;
    this.frequency = frequency; this.epoch++; this.changedAt = Date.now(); this.previousEnd = 0;
    this.recordRetune(frequency);
  }

  start() {
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      if (this.work || this.stopped) return;
      this.work = this.poll().catch(error => {
        if (!this.stopped) { clearInterval(this.timer); this.emit('failure', error); }
      }).finally(() => { this.work = null; });
    }, 100);
    this.timer.unref?.();
  }

  async poll() {
    if (this.recordingStopping) return;
    const { size } = await this.file.stat();
    if (size < this.previousSize) { this.metadata = null; this.reclaimed = 0; this.previousEnd = 0; this.epoch++; this.changedAt = Date.now(); }
    this.previousSize = size;
    if (this.recording) {
      try { await this.copyRecording(size); }
      catch (error) { await this.finishRecording({ error }); }
    }
    const reclaimTo = Math.floor((size - KEEP_BYTES) / ALLOCATION_UNIT) * ALLOCATION_UNIT;
    if (reclaimTo > this.reclaimed) { await this.sparse.release(this.reclaimed, reclaimTo); this.reclaimed = reclaimTo; }
    if (!this.metadata) {
      try {
        const value = JSON.parse(await fs.readFile(this.metadataFile, 'utf8'));
        if (value.sample_format !== 'cu8' || !Number.isFinite(value.sample_rate_hz) || value.sample_rate_hz <= 0) throw new Error('The decoder RF feed is not unsigned 8-bit IQ.');
        this.metadata = value;
      } catch (error) {
        if (Date.now() - this.startedAt > 8000 || (error.code !== 'ENOENT' && !(error instanceof SyntaxError))) throw error;
        return;
      }
    }
    const end = Math.floor(size / 2) * 2;
    if (end < RF_WINDOW_BYTES || end === this.previousEnd || Date.now() - this.changedAt < 40) return;
    const epoch = this.epoch;
    const bytes = Buffer.alloc(RF_WINDOW_BYTES);
    const { bytesRead } = await this.file.read(bytes, 0, bytes.length, end - bytes.length);
    if (this.stopped || epoch !== this.epoch || bytesRead !== bytes.length) return;
    this.previousEnd = end;
    const offset = Number(this.metadata.capture_center_frequency_hz) - Number(this.metadata.center_frequency_hz);
    const center = this.frequency + (Number.isFinite(offset) ? offset : 0);
    this.emit('spectrum', { type: 'spectrum', source: 'digital', bins: spectrumFromCu8(bytes),
      center, span: this.metadata.sample_rate_hz, tunedFrequency: this.frequency,
      timestamp: Date.now(), epoch: `${this.session}:${this.epoch}`, units: 'dBFS' });
  }

  async copyRecording(size) {
    const recording = this.recording;
    if (!recording) return;
    if (recording.bytes >= RECORDING_LIMIT_BYTES) {
      recording.sizeLimitReached = true;
      await this.finishRecording({ sizeLimitReached: true });
      return;
    }
    const end = Math.floor(Math.min(size, recording.sourceStart + RECORDING_LIMIT_BYTES) / 2) * 2;
    while (recording.sourceEnd < end && this.recording === recording) {
      const length = Math.min(RECORDING_COPY_CHUNK_BYTES, end - recording.sourceEnd);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await this.file.read(chunk, 0, length, recording.sourceEnd);
      const aligned = bytesRead - (bytesRead % 2);
      if (aligned <= 0) break;
      let written = 0;
      while (written < aligned) {
        const result = await recording.file.write(chunk, written, aligned - written, recording.bytes + written);
        if (!result.bytesWritten) throw new Error('The IQ recording could not write more data.');
        written += result.bytesWritten;
      }
      recording.sourceEnd += aligned;
      recording.bytes += aligned;
    }
    if (recording.bytes >= RECORDING_LIMIT_BYTES) {
      recording.sizeLimitReached = true;
      await this.finishRecording({ sizeLimitReached: true });
      return;
    }
    if (Date.now() - recording.lastUpdateAt >= 1000) {
      recording.lastUpdateAt = Date.now();
      this.emit('recording', this.recordingState);
    }
  }

  close() { return this.closing ||= this.finishClose(); }

  async finishClose() {
    this.stopped = true; clearInterval(this.timer);
    await this.work;
    if (this.recording) await this.stopRecording();
    this.sparse?.close(); this.sparse = null;
    await this.file?.close().catch(() => {}); this.file = null;
    // These exact, app-created paths are removed only after the decoder closes.
    for (const filename of [this.filename, this.metadataFile]) {
      try { await fs.unlink(filename); } catch (error) { if (error.code !== 'ENOENT') this.emit('cleanup-warning', error); }
    }
  }
}
