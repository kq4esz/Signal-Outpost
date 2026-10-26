import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DigitalAudio } from './digital-audio.mjs';
import { DecoderSpectrum } from './decoder-spectrum.mjs';
import { guardDecoderProcess, signalDecoderProcess } from './native-process.mjs';

const NATIVE = fileURLToPath(new URL('../native/digital/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(NATIVE, 'manifest.json'), 'utf8'));
const PLATFORM = `${process.platform}-${process.arch}`;
const runtime = manifest.runtimes?.[PLATFORM] || null;
const EXECUTABLE = runtime?.executable ? path.join(NATIVE, runtime.executable) : null;
const TOPICS = new Set(['call', 'event', 'system', 'metrics', 'quality', 'status']);

export function digitalRuntime() {
  return { name: manifest.name, version: manifest.version, channel: manifest.channel,
    available: Boolean(runtime?.sha256 && EXECUTABLE && fs.existsSync(EXECUTABLE)),
    codec: 'mbelib-neo · IMBE / AMBE', source: manifest.source };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const fail = error => { socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.setTimeout(600, () => fail(new Error('Decoder control connection timed out.')));
    socket.once('connect', () => { socket.removeListener('error', fail); socket.setTimeout(0); resolve(socket); });
  });
}

export class DigitalDecoder extends EventEmitter {
  constructor({ args, channels, dataDir, protocol, config, frequency }) {
    super();
    this.args = args;
    this.dataDir = dataDir;
    this.protocol = protocol;
    this.config = config;
    this.frequency = frequency;
    this.audio = new DigitalAudio(channels);
    this.child = null;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 0;
    this.phase = 'idle';
    this.stopping = false;
    this.failed = false;
    this.history = [];
    this.logs = [];
    this.telemetry = {};
    this.lastError = '';
    this.startedAt = null;
    this.audioFrames = 0;
    this.runDir = null;
  }

  get active() { return ['starting', 'listening'].includes(this.phase); }

  snapshot() {
    return { engine: 'integrated', phase: this.phase, protocol: this.protocol, config: this.config, identity: this.identity || null, frequency: this.frequency,
      runtime: digitalRuntime(), startedAt: this.startedAt, audioFrames: this.audioFrames,
      calls: this.telemetry.call?.slots || [], system: this.telemetry.system || null,
      metrics: this.telemetry.metrics || null, quality: this.telemetry.quality || null,
      decoderStatus: this.telemetry.status || null, lastError: this.lastError };
  }

  async start() {
    if (this.phase !== 'idle') throw new Error('This decoder session has already been used.');
    if (!digitalRuntime().available) throw new Error('The bundled digital decoder is unavailable for this platform.');
    const hash = createHash('sha256').update(fs.readFileSync(EXECUTABLE)).digest('hex');
    if (hash !== runtime.sha256) throw new Error('The bundled decoder executable does not match its pinned build. Restore native/digital from the application package.');
    this.phase = 'starting';
    this.startedAt = new Date().toISOString();
    try {
      const port = await freePort();
      if (this.stopping) throw new Error('Decoder start cancelled.');
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.runDir = fs.mkdtempSync(path.join(this.dataDir, 'session-'));
      this.spectrumTap = new DecoderSpectrum(this.runDir, this.frequency);
      await this.spectrumTap.prepare();
      this.spectrumTap.on('spectrum', frame => { if (!this.stopping) this.emit('spectrum', frame); });
      this.spectrumTap.on('failure', error => {
        if (this.stopping) return;
        this.lastError = `RF spectrum feed stopped: ${error.message}`;
        this.failed = true; this.phase = 'failed';
        this.emit('failure', new Error(this.lastError)); void this.stop();
      });
      const token = randomBytes(32).toString('hex');
      const tokenFile = path.join(this.runDir, 'control.token');
      fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
      const env = { ...process.env };
      // A user's standalone DSD configuration must not change this embedded session.
      for (const key of Object.keys(env)) if (key.startsWith('DSD_NEO_')) delete env[key];
      if ((process.platform === 'linux' || process.platform === 'darwin') && runtime.libraryDirectory) {
        const libraryDirectory = path.join(NATIVE, runtime.libraryDirectory);
        const variable = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
        env[variable] = [libraryDirectory, env[variable]].filter(Boolean).join(path.delimiter);
      }
      const child = spawn(EXECUTABLE, [...this.args, ...this.spectrumTap.args, '--frontend', 'none', '-o', '-',
        '--api', String(port), '--api-bind', '127.0.0.1', '--api-token-file', tokenFile], {
        cwd: this.runDir, windowsHide: true, detached: process.platform === 'linux' || process.platform === 'darwin', env, stdio: ['ignore', 'pipe', 'pipe']
      });
      this.child = child;
      this.exited = new Promise(resolve => child.once('close', resolve));
      child.stdout.on('data', chunk => {
        if (this.stopping) return;
        const audio = this.audio.push(chunk);
        this.audioFrames = this.audio.frames;
        if (audio.samples.length) this.emit('audio', audio);
      });
      let logBuffer = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        logBuffer += chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        const lines = logBuffer.split(/[\r\n]+/); logBuffer = lines.pop().slice(-8192);
        for (const line of lines) if (line.trim()) this.log(line.trim());
      });
      child.once('error', error => { this.lastError = error.message; });
      child.once('close', (code, signal) => {
        this.closeJob?.(); this.closeJob = null;
        if (logBuffer.trim()) this.log(logBuffer.trim());
        this.socket?.destroy();
        this.rejectPending(new Error('The digital decoder stopped.'));
        if (!this.stopping) {
          this.failed = true;
          this.phase = 'failed';
          this.lastError ||= `Decoder exited (${code ?? signal ?? 'unknown'}). ${this.logs.slice(-3).join(' ')}`;
          this.emit('failure', new Error(this.lastError));
        } else this.phase = this.failed ? 'failed' : 'stopped';
        this.removeToken();
        void this.spectrumTap?.close().then(() => this.removeToken());
        this.emit('stopped', { code, signal });
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      this.closeJob = guardDecoderProcess(child.pid);
      this.spectrumTap.start();
      const deadline = Date.now() + 15000;
      while (!this.socket && Date.now() < deadline && !this.stopping && child.exitCode === null && child.signalCode === null) {
        try { this.socket = await connect(port); } catch { await delay(120); }
      }
      if (!this.socket) throw new Error(this.lastError || `The decoder did not open its control API. ${this.logs.slice(-3).join(' ')}`);
      this.attachSocket(this.socket);
      await this.request('auth', { token });
      await this.request('subscribe', { topics: [...TOPICS] });
      while (!this.telemetry.metrics?.stream_active && Date.now() < deadline && !this.stopping && this.phase !== 'failed') await delay(100);
      if (this.stopping) throw new Error(this.lastError || 'Decoder start cancelled.');
      if (this.phase === 'failed' || !this.telemetry.metrics?.stream_active) throw new Error(this.lastError || `The decoder could not start the RTL-SDR USB stream. ${this.logs.slice(-3).join(' ')}`);
      this.phase = 'listening';
      this.emit('state', this.snapshot());
      return this.snapshot();
    } catch (error) {
      this.lastError = error.message;
      this.failed = true;
      await this.stop();
      this.phase = 'failed';
      throw error;
    }
  }

  log(message) {
    const retune=message.match(/\bRetune applied(?: with warning)?: (\d+) Hz/)
      || message.match(/\b(?:Applied|Accepted(?: \(pending\))?): (?:RTL frequency|P25 control channel) -> (\d+) Hz/);
    if(retune)this.noteFrequency(Number(retune[1]));
    this.logs.push(message.slice(0, 2000)); this.logs = this.logs.slice(-60);
    this.emit('log', message.slice(0, 2000));
  }

  noteFrequency(frequency) {
    const value = Number(frequency);
    if (!Number.isFinite(value) || value < 10000 || value > 0xffffffff || value === this.frequency) return;
    this.frequency = value; this.lastRetuneAt = Date.now();
    this.spectrumTap?.tune(value); this.emit('tuned', value);
  }

  attachSocket(socket) {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { socket.destroy(new Error('Oversized decoder telemetry.')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const request = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(request.timer);
          if (message.ok) request.resolve(message);
          else request.reject(new Error(message.error?.message || 'Decoder command was refused.'));
        } else if (TOPICS.has(message.type)) {
          if (message.type === 'event') {
            const row=message.row;
            if(row?.access_code_kind===2&&!row.crc_invalid&&Number.isInteger(row.access_code)&&row.access_code>=0&&row.access_code<=0xfff)this.identity={frequency:Number(row.freq_hz),nac:row.access_code};
            const key = `${message.row?.ring}:${message.row?.slot}:${message.row?.push}`;
            const index = this.history.findIndex(event => event.key === key);
            const event = { key, ...message.row };
            if (index >= 0) this.history[index] = event; else this.history.push(event);
            this.history = this.history.slice(-100);
            this.emit('event', event);
          } else {
            this.telemetry[message.type] = message;
            if ((message.type === 'status' || message.type === 'system') && Date.now()-(this.lastRetuneAt||0)>350) {
              const frequency=Number(message.center_freq_hz);
              this.noteFrequency(frequency);
            }
            if (message.type === 'metrics' || message.type === 'status') this.emit('state', this.snapshot());
          }
        }
      }
    });
    socket.on('error', error => { this.lastError = error.message; });
    socket.once('close', () => {
      this.rejectPending(new Error('Decoder control connection closed.'));
      if (!this.stopping && this.phase !== 'failed') {
        this.lastError = 'The decoder control connection closed. The session has been stopped.';
        this.failed = true;
        this.phase = 'failed';
        this.emit('failure', new Error(this.lastError));
        void this.stop();
      }
    });
  }

  request(cmd, params = {}) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Decoder control is unavailable.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Decoder command timed out: ${cmd}`)); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, cmd, params }) + '\n');
    });
  }

  async retune(frequency) {
    const target = Math.round(Number(frequency));
    if (!Number.isInteger(target) || target < 10000 || target > 0xffffffff) throw new Error('Choose a valid RTL control-channel frequency.');
    if (!this.active || this.phase !== 'listening') throw new Error('The integrated decoder is not ready to retune.');
    if (target !== this.frequency) {
      await this.request('rtl_set_freq', { value: target });
      // rtl_set_freq is queued by DSD-neo while its librtlsdr stream stays open.
      // Reflect the accepted target immediately; telemetry/logs can still correct it.
      this.noteFrequency(target);
    }
  }

  rejectPending(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  removeToken() {
    if (!this.runDir) return;
    // Only remove the known token and an empty session directory; never recurse.
    try { fs.unlinkSync(path.join(this.runDir, 'control.token')); } catch {}
    try { fs.rmdirSync(this.runDir); } catch {}
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  async finishStop() {
    this.stopping = true;
    this.phase = 'stopping';
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (this.socket && !this.socket.destroyed) {
        try { this.socket.write(JSON.stringify({ id: ++this.nextId, cmd: 'quit' }) + '\n'); } catch {}
      }
      await Promise.race([this.exited, delay(1000)]);
      if (child.exitCode === null && child.signalCode === null) signalDecoderProcess(child, 'SIGTERM');
      await Promise.race([this.exited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) signalDecoderProcess(child, 'SIGKILL');
    }
    this.socket?.destroy();
    this.rejectPending(new Error('Decoder stopped.'));
    this.closeJob?.(); this.closeJob = null;
    await this.spectrumTap?.close();
    this.removeToken();
    this.phase = this.failed ? 'failed' : 'stopped';
    this.emit('state', this.snapshot());
  }
}
