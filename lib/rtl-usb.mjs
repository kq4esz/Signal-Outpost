import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'lib', 'rtl-usb-worker.mjs');

export function rtlLibraryPath(custom = '') {
  if (custom) {
    const candidate = path.resolve(custom);
    if (!fs.existsSync(candidate)) throw new Error('RTL-SDR library not found. Choose a valid native RTL-SDR library in Hardware settings.');
    return candidate;
  }
  if (process.platform === 'win32') {
    const bundled = path.join(ROOT, 'native', `win32-${process.arch}`, 'rtlsdr.dll');
    if (fs.existsSync(bundled)) return bundled;
    throw new Error(`The RTL-SDR library for Windows ${process.arch} is missing. Run setup-signal-outpost.cmd.`);
  }
  if (process.platform === 'linux') {
    if (process.env.RTLSDR_LIBRARY) return process.env.RTLSDR_LIBRARY;
    const bundled = path.join(ROOT, 'native', 'digital', 'linux-x64', 'lib', 'librtlsdr-app.so');
    return fs.existsSync(bundled) ? bundled : 'librtlsdr.so.0';
  }
  if (process.platform === 'darwin') {
    if (process.env.RTLSDR_LIBRARY) return process.env.RTLSDR_LIBRARY;
    const bundled = path.join(ROOT, 'native', 'digital', `darwin-${process.arch}`, 'lib', 'librtlsdr-app.dylib');
    return fs.existsSync(bundled) ? bundled : 'librtlsdr.dylib';
  }
  return process.env.RTLSDR_LIBRARY || 'librtlsdr.so.0';
}

function spawnHelper(libraryPath, args = []) {
  const libraryDirectory = path.isAbsolute(libraryPath) ? path.dirname(libraryPath) : null;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SDREXTREME_RTL_LIBRARY: libraryPath };
  if (libraryDirectory && process.platform === 'win32') env.PATH = `${libraryDirectory}${path.delimiter}${env.PATH || ''}`;
  if (libraryDirectory && process.platform === 'linux') env.LD_LIBRARY_PATH = `${libraryDirectory}${path.delimiter}${env.LD_LIBRARY_PATH || ''}`;
  if (libraryDirectory && process.platform === 'darwin') env.DYLD_LIBRARY_PATH = `${libraryDirectory}${path.delimiter}${env.DYLD_LIBRARY_PATH || ''}`;
  return spawn(process.execPath, [HELPER, ...args], {
    cwd: libraryDirectory || ROOT,
    windowsHide: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

export async function listUsbDevices(customPath = '') {
  let libraryPath;
  try { libraryPath = rtlLibraryPath(customPath); }
  catch (error) { return { available: false, devices: [], error: error.message }; }
  return new Promise(resolve => {
    const child = spawnHelper(libraryPath, ['--list']);
    let output = '', diagnostics = '', finished = false;
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish({ available: false, devices: [], libraryPath, error: 'USB discovery timed out. Close other SDR programs and try Refresh.' }); }, 8000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-100000); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
    child.on('error', error => finish({ available: false, devices: [], error: error.message, libraryPath }));
    child.on('exit', () => {
      try { finish(JSON.parse(output)); }
      catch { finish({ available: false, devices: [], libraryPath, error: diagnostics.trim() || 'The native RTL-SDR library could not be loaded.' }); }
    });
  });
}

/** Direct librtlsdr USB acquisition. IQ travels over an anonymous OS pipe, never RTL-TCP. */
export class UsbReceiver extends EventEmitter {
  connected = false;
  pending = new Map();
  sequence = 0;
  bytes = 0;

  async start(config) {
    this.libraryPath = rtlLibraryPath(config.libraryPath);
    this.child = spawnHelper(this.libraryPath);
    this.startedAt = Date.now();
    this.lastDiagnostics = '';
    this.child.stdin.on('error', () => {});
    let metadata = '', remainder = null;
    this.child.stdout.on('data', chunk => {
      if (remainder) { chunk = Buffer.concat([remainder, chunk]); remainder = null; }
      if (chunk.length % 2) { remainder = chunk.subarray(-1); chunk = chunk.subarray(0, -1); }
      if (chunk.length) { this.bytes += chunk.length; this.emit('iq', chunk); }
    });
    this.child.stderr.on('data', chunk => {
      metadata += chunk.toString();
      let end;
      while ((end = metadata.indexOf('\n')) >= 0) {
        const line = metadata.slice(0, end).trim(); metadata = metadata.slice(end + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') { this.connected = true; this.info = message.info; this.emit('ready', message.info); }
          else if (message.type === 'reply') {
            const pending = this.pending.get(message.id);
            if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
          } else if (message.type === 'fatal') { this.lastDiagnostics = message.error; this.emit('failure', new Error(message.error)); }
          else this.emit('log', message.message || line);
        } catch { this.lastDiagnostics = line; this.emit('log', line); }
      }
      if (metadata.length > 16000) metadata = metadata.slice(-4000);
    });
    this.child.on('error', error => this.emit('failure', error));
    this.child.on('exit', code => {
      this.connected = false;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('USB receiver stopped.')); }
      this.pending.clear();
      this.emit('stopped', { code, message: this.lastDiagnostics });
    });
    return new Promise((resolve, reject) => {
      const ready = info => { cleanup(); resolve(info); };
      const failure = error => { cleanup(); this.child.kill(); reject(error); };
      const stopped = ({ message }) => failure(new Error(message || 'The USB receiver exited before opening the device.'));
      const timer = setTimeout(() => failure(new Error('The USB device did not respond. Check USB permissions and close other SDR applications.')), 10000);
      const cleanup = () => { clearTimeout(timer); this.off('ready', ready); this.off('failure', failure); this.off('stopped', stopped); };
      this.once('ready', ready); this.once('failure', failure); this.once('stopped', stopped);
      this.child.stdin.write(JSON.stringify({ op: 'start', config }) + '\n');
    });
  }

  command(op, value) {
    if (!this.connected || !this.child?.stdin.writable) return Promise.reject(new Error('RTL-SDR USB is disconnected.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`USB ${op} command timed out.`)); }, 4000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, value }) + '\n');
    });
  }

  async close() {
    this.connected = false;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.kill(); finish(); }, 1200);
      child.once('exit', finish);
      if (child.stdin.writable) child.stdin.write('{"op":"stop"}\n');
      else { child.kill(); }
    });
  }
}
