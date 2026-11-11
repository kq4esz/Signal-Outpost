import http from 'node:http';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsbReceiver, listUsbDevices, rtlLibraryPath } from './lib/rtl-usb.mjs';
import { KiwiDirectory } from './lib/kiwi-directory.mjs';
import { DIGITAL_MODES, digitalOptions, resolveProtocol, decoderFlags, protocolLabel, importedProtocol, channelMapRows } from './lib/channel-protocols.mjs';
import { normalizeMemory } from './lib/memory-channels.mjs';
import { MemoryScanner, scanPlan, spectrumSnr } from './lib/memory-scanner.mjs';
import { DigitalDecoder, digitalRuntime } from './lib/digital-decoder.mjs';
import { HdRadio, hdRuntime } from './lib/hd-radio.mjs';
import { hdBandForFrequency, hdProgram } from './lib/hd-options.mjs';
import { MeshCoreClient, meshcoreCatalog } from './lib/meshcore.mjs';
import { Propagation } from './lib/propagation.mjs';
import { parseWsjtPacket } from './lib/wsjt-decodes.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PORT = Number(process.env.SDREXTREME_PORT || 17890);
const DATA_DIR = path.resolve(process.env.SDREXTREME_DATA_DIR || path.join(ROOT, 'local-data'));
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MODES = new Set(['AM', 'NFM', 'WFM', 'USB', 'LSB', 'CW', 'RAW', 'HD', 'P25', 'DMR', 'NXDN', 'D-STAR', 'YSF', 'M17']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

fs.mkdirSync(DATA_DIR, { recursive: true });
const defaults = {
  channels: [],
  settings: { rtlLibraryPath: '', deviceIndex: 0, deviceSerial: '', ppm: 0, tunerGain: 0, rtlAgc: false, directSampling: 0, tunerBandwidth: 0, biasTee: false, digitalEngine: 'integrated', dsdPath: '', kiwiUrl: '', kiwiFavorites: [], wsjtPort: 2237, sampleRate: 2400000, hdFmFallback: true }
};
if (!fs.existsSync(CHANNELS_FILE)) fs.writeFileSync(CHANNELS_FILE, JSON.stringify(defaults.channels, null, 2));
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaults.settings, null, 2));

let channels = readJson(CHANNELS_FILE, defaults.channels);
channels = channels.map(channel => { try { return { ...channel, ...normalizeMemory(channel, false) }; } catch { return channel; } });
let settings = { ...defaults.settings, ...readJson(SETTINGS_FILE, defaults.settings) };
delete settings.rtlTcpPath;
const kiwiDirectory = new KiwiDirectory(DATA_DIR);
const propagation = new Propagation(DATA_DIR);
const wsjtSessions = new Map();
let receiver = null;
let hdSession = null, hdStarting = false, hdGeneration = 0, lastHdState = null;
let digitalProcess = null;
let digitalSession = null;
let digitalStarting = false;
let digitalGeneration = 0;
let lastDigitalState = null;
let activeDigitalConfig = null;
let digitalHistory = [];
let lastDigitalBroadcast = 0;
let digitalScan = null;
let wsjtSocket = null;
let wsjtPort = null;
let wsjtReady = false, wsjtStarting = false, wsjtGeneration = 0;
let scanner = null;
let trunkedScanner = null;
let selectedChannelId = null;
let appMode = 'NFM';
let activeFrequency = 100000000;
let activeGain = 0;
let sampleRate = 2400000;
let rtlInfo = null;
let lastSpectrumAt = 0;
let spectrumRefreshCounter = 0;
let recentDecodes = [];
let clients = new Set();
const meshcore = new MeshCoreClient(DATA_DIR);
meshcore.on('state', mesh => broadcast({ type: 'meshcore-state', mesh }));
meshcore.on('ble-frame', frame => broadcast({ type: 'meshcore-frame', ...frame }));
let cwState = { unit: 100, keyed: false, markMs: 0, gapMs: 0, pattern: '', text: '', noise: 0.008, peak: 0.04, envelope: 0 };
const MORSE = { '.-':'A','-...':'B','-.-.':'C','-..':'D','.':'E','..-.':'F','--.':'G','....':'H','..':'I','.---':'J','-.-':'K','.-..':'L','--':'M','-.':'N','---':'O','.--.':'P','--.-':'Q','.-.':'R','...':'S','-':'T','..-':'U','...-':'V','.--':'W','-..-':'X','-.--':'Y','--..':'Z','-----':'0','.----':'1','..---':'2','...--':'3','....-':'4','.....':'5','-....':'6','--...':'7','---..':'8','----.':'9','.-.-.-':'.','--..--':',','..--..':'?','-..-.':'/','-.-.--':'!','.-..-.':'"','-.--.':'(','-.--.-':')','.-.-.':'+','-....-':'-','...-..-':'$','.-.-':'Ä','---.':'Ö','.--.-':'Å','..--':'Ü' };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': 'http://127.0.0.1:' + PORT });
  res.end(JSON.stringify(data));
}
function parseBody(req, max = 2_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > max) { reject(new Error('Request is too large.')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON request.')); } });
    req.on('error', reject);
  });
}
function validFrequency(value) {
  const f = Number(value);
  if (!Number.isFinite(f) || f < 10000 || f > 1_766_000_000) throw new Error('Enter a frequency between 10 kHz and 1.766 GHz.');
  return Math.round(f);
}
function broadcast(obj) {
  const message = Buffer.from(JSON.stringify(obj));
  const frame = makeWsFrame(message, 1);
  for (const client of [...clients]) {
    if (client.destroyed) clients.delete(client);
    else client.write(frame);
  }
}
function makeWsFrame(payload, opcode = 2) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function sendBinary(socket, payload) { if (!socket.destroyed && socket.writableLength < 524288) socket.write(makeWsFrame(payload, 2)); }
function broadcastSpectrum(value) {
  const frame = makeWsFrame(Buffer.from(JSON.stringify(value)), 1);
  for (const client of clients) if (!client.destroyed && client.writableLength < 524288) client.write(frame);
}
function status() {
  const scan = scanner?.active ? scanner.snapshot() : trunkedScanner?.active ? trunkedScanSnapshot(trunkedScanner) : digitalScan;
  return {
    connected: Boolean(receiver?.connected), transport: 'USB', appVersion: APP_VERSION,
    dataProfile: createHash('sha256').update(process.platform === 'win32' ? DATA_DIR.toLowerCase() : DATA_DIR).digest('hex').slice(0, 16),
    hdActive: Boolean(hdSession?.active), hdStarting, hd: hdSession?.snapshot() || lastHdState, hdFmFallback: settings.hdFmFallback !== false,
    digitalActive: Boolean(digitalProcess || digitalSession?.active), digitalStarting,
    digital: digitalSession?.snapshot() || (digitalProcess ? { engine: 'external', phase: 'listening', config: activeDigitalConfig } : lastDigitalState), mode: appMode, frequency: activeFrequency, gain: activeGain,
    sampleRate, rtlInfo: hdSession?.active ? hdSession.usb?.info || null : rtlInfo, selectedChannelId, scannerActive: Boolean(scan?.active), scan, wsjtActive: wsjtReady,
    wsjtPort, recentDecodes: recentDecodes.slice(-50), host: os.hostname(),
    usb: receiver?.connected ? { bytes: receiver.bytes, streamingSince: receiver.startedAt, deviceIndex: rtlInfo?.index, serial: rtlInfo?.serial } : null
  };
}
function setSettings(next) {
  settings = { ...settings, ...next };
  writeJson(SETTINGS_FILE, settings);
}
async function tune(freq) {
  const next = validFrequency(freq);
  if (hdStarting) throw new Error('Wait for HD Radio to finish starting.');
  if (trunkedScanner?.active) throw new Error('Stop the trunked site scan before tuning manually.');
  if (hdSession?.active) { await startHd({ frequency: next, program: hdSession.program }); return; }
  if (digitalSession?.active) {
    if (digitalScan) throw new Error('Stop the digital memory scan before tuning manually.');
    await digitalSession.request('rtl_set_freq', { value: next });
  } else if (digitalProcess) throw new Error('Stop the external decoder before tuning from Signal Outpost.');
  if (receiver?.connected) await receiver.command('frequency', next);
  activeFrequency = next;
  resetDsp();
  broadcast({ type: 'status', status: status() });
}

let phaseI = 1, phaseQ = 0, previousI = 0, previousQ = 0, havePrevious = false;
let decimationCount = 0, audioAccumulator = 0, audioSamples = [], spectrumI = new Float32Array(1024), spectrumQ = new Float32Array(1024), spectrumCount = 0;
let dcInput = 0, dcOutput = 0, wfmDeemphasis = 0, rmsSum = 0, rmsCount = 0;
function resetDsp() {
  phaseI = 1; phaseQ = 0; previousI = 0; previousQ = 0; havePrevious = false;
  decimationCount = 0; audioAccumulator = 0; audioSamples = []; spectrumCount = 0; rmsSum = 0; rmsCount = 0; dcInput = 0; dcOutput = 0; wfmDeemphasis = 0;
  spectrumRefreshCounter = 0;
  cwState = { unit: 100, keyed: false, markMs: 0, gapMs: 0, pattern: '', text: '', noise: 0.008, peak: 0.04, envelope: 0 };
}
function cwEmitCharacter() {
  if (!cwState.pattern) return;
  const decoded = MORSE[cwState.pattern] || '�';
  cwState.pattern = '';
  cwState.text = (cwState.text + decoded).slice(-300);
  broadcast({ type: 'cw-text', text: cwState.text, character: decoded });
}
function decodeCw(samples) {
  if (appMode !== 'CW') return;
  const windowSize = 480;
  for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
    let power = 0;
    for (let i = start; i < start + windowSize; i++) power += samples[i] * samples[i];
    const raw = Math.sqrt(power / windowSize);
    cwState.envelope = cwState.envelope * 0.55 + raw * 0.45;
    const keyed = cwState.envelope > Math.max(0.006, cwState.noise * 2.2, cwState.peak * 0.28);
    if (keyed) cwState.peak = Math.max(cwState.envelope, cwState.peak * 0.985);
    else cwState.noise = cwState.noise * 0.95 + cwState.envelope * 0.05;
    if (keyed !== cwState.keyed) {
      if (keyed) {
        if (cwState.gapMs >= cwState.unit * 6.5) { cwEmitCharacter(); cwState.text = (cwState.text + ' ').slice(-300); broadcast({ type: 'cw-text', text: cwState.text }); }
        else if (cwState.gapMs >= cwState.unit * 2.7) cwEmitCharacter();
        cwState.gapMs = 0; cwState.markMs = 0; cwState.keyed = true;
      } else {
        cwState.keyed = false;
        const mark = cwState.markMs;
        if (mark >= 30 && mark <= 2000) {
          const units = mark >= cwState.unit * 2 ? 3 : 1;
          cwState.pattern += units === 3 ? '-' : '.';
          cwState.unit = Math.max(35, Math.min(500, cwState.unit * 0.72 + (mark / units) * 0.28));
        }
      }
    }
    if (cwState.keyed) cwState.markMs += 10; else cwState.gapMs += 10;
    if (!cwState.keyed && cwState.gapMs >= cwState.unit * 3.4 && cwState.pattern) cwEmitCharacter();
  }
}
function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len, wr0 = Math.cos(angle), wi0 = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const uR = real[i + j], uI = imag[i + j];
        const vR = real[i + j + len / 2] * wr - imag[i + j + len / 2] * wi;
        const vI = real[i + j + len / 2] * wi + imag[i + j + len / 2] * wr;
        real[i + j] = uR + vR; imag[i + j] = uI + vI;
        real[i + j + len / 2] = uR - vR; imag[i + j + len / 2] = uI - vI;
        const nextWr = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = nextWr;
      }
    }
  }
}
function publishSpectrum() {
  const n = spectrumI.length;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    re[i] = spectrumI[i] * w; im[i] = spectrumQ[i] * w;
  }
  fft(re, im);
  const half = n >> 1, bins = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = (i + half) % n;
    const magnitude = Math.hypot(re[k], im[k]) / n;
    bins[i] = Math.max(-100, Math.min(-8, 20 * Math.log10(Math.max(magnitude, 0.000003)) + 20));
  }
  broadcastSpectrum({ type: 'spectrum', source: 'usb', bins, center: activeFrequency, tunedFrequency: activeFrequency, span: sampleRate, timestamp: Date.now(), epoch: `usb:${activeFrequency}:${sampleRate}` });
  if (scanner?.active) scanner.observe(spectrumSnr(bins, sampleRate, appMode));
  spectrumCount = 0;
}
function processIq(buffer) {
  if (!receiver) return;
  const factor = Math.max(1, Math.round(sampleRate / 48000));
  const outRate = sampleRate / factor;
  const fmDeviationHz = appMode === 'WFM' ? 75000 : appMode === 'NFM' ? 5000 : 0;
  const fmAudioScale = fmDeviationHz ? 0.72 * sampleRate / (2 * Math.PI * fmDeviationHz) : 0.7;
  const wfmDeemphasisAlpha = appMode === 'WFM' ? Math.exp(-1 / (outRate * 75e-6)) : 0;
  const mix = ['USB', 'LSB', 'CW'].includes(appMode);
  const mixFrequency = appMode === 'CW' ? 700 : 1500;
  const direction = appMode === 'LSB' ? 1 : -1;
  const stepAngle = mix ? direction * 2 * Math.PI * mixFrequency / sampleRate : 0;
  const stepI = Math.cos(stepAngle), stepQ = Math.sin(stepAngle);
  let localPhaseI = phaseI, localPhaseQ = phaseQ;
  const output = audioSamples;
  for (let p = 0; p + 1 < buffer.length; p += 2) {
    const rawI = (buffer[p] - 127.5) / 127.5, rawQ = (buffer[p + 1] - 127.5) / 127.5;
    if (spectrumCount < spectrumI.length) { spectrumI[spectrumCount] = rawI; spectrumQ[spectrumCount] = rawQ; spectrumCount++; }
    let sample;
    if (appMode === 'AM') {
      const envelope = Math.hypot(rawI, rawQ);
      const y = envelope - dcInput + 0.996 * dcOutput;
      dcInput = envelope; dcOutput = y; sample = y * 4;
    } else if (['NFM', 'WFM', 'P25', 'DMR', 'NXDN', 'D-STAR', 'YSF', 'M17'].includes(appMode)) {
      if (!havePrevious) { previousI = rawI; previousQ = rawQ; havePrevious = true; sample = 0; }
      else {
        const cross = previousI * rawQ - previousQ * rawI;
        const dot = previousI * rawI + previousQ * rawQ;
        sample = Math.atan2(cross, dot) * fmAudioScale;
        previousI = rawI; previousQ = rawQ;
      }
    } else if (mix) {
      const mixedI = rawI * localPhaseI - rawQ * localPhaseQ;
      const mixedQ = rawI * localPhaseQ + rawQ * localPhaseI;
      sample = mixedI * 4;
      const nextI = localPhaseI * stepI - localPhaseQ * stepQ;
      localPhaseQ = localPhaseI * stepQ + localPhaseQ * stepI;
      localPhaseI = nextI;
    } else sample = 0;
    audioAccumulator += sample;
    decimationCount++;
    if (decimationCount >= factor) {
      let audio = audioAccumulator / factor;
      if (appMode === 'WFM') {
        audio = audio * (1 - wfmDeemphasisAlpha) + wfmDeemphasis * wfmDeemphasisAlpha;
        wfmDeemphasis = audio;
      }
      audio = Math.max(-1, Math.min(1, audio));
      output.push(audio);
      rmsSum += audio * audio; rmsCount++;
      audioAccumulator = 0; decimationCount = 0;
    }
    if (spectrumCount >= spectrumI.length && ++spectrumRefreshCounter >= 8192) {
      spectrumRefreshCounter = 0;
      const now = Date.now();
      if (now - lastSpectrumAt >= 50) { publishSpectrum(); lastSpectrumAt = now; }
    }
  }
  phaseI = localPhaseI; phaseQ = localPhaseQ;
  if (output.length >= 4800) {
    const chunk = Float32Array.from(output.splice(0, 4800));
    const audible = !scanner?.active || scanner.holding || !scanner.plan.holdOnSignal;
    if (audible) decodeCw(chunk);
    const frame = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (audible) for (const client of clients) if (!client.destroyed) sendBinary(client, frame);
    broadcast({ type: 'meter', level: audible && rmsCount ? Math.sqrt(rmsSum / rmsCount) : 0, sampleRate: outRate });
    rmsSum = 0; rmsCount = 0;
  }
}

async function startReceiver(body = {}) {
  if (body.mode === 'HD') return startHd(body);
  if (hdStarting) throw new Error('Wait for HD Radio to finish starting.');
  if (digitalProcess || digitalSession?.active || digitalStarting) throw new Error('Stop the digital decoder before opening the USB receiver.');
  await stopHd();
  if (!body.keepScan) stopScan();
  if (receiver) await stopReceiver({ keepScan: body.keepScan === true });
  const freq = validFrequency(body.frequency ?? activeFrequency);
  const rate = Number(body.sampleRate || settings.sampleRate || 2400000);
  if (![1024000, 1200000, 1800000, 2048000, 2400000, 2560000, 2880000, 3200000].includes(rate)) throw new Error('Choose a supported USB sample rate.');
  const gain = Math.max(0, Math.min(500, Math.round(Number(body.gain) || 0)));
  const usb = new UsbReceiver();
  receiver = usb;
  sampleRate = rate; activeFrequency = freq; activeGain = gain;
  appMode = MODES.has(body.mode) ? body.mode : appMode;
  resetDsp();
  usb.on('iq', chunk => { if (receiver === usb && usb.connected) processIq(chunk); });
  usb.on('log', message => broadcast({ type: 'log', source: 'RTL-SDR USB', message }));
  usb.on('failure', error => broadcast({ type: 'log', source: 'RTL-SDR USB', message: error.message }));
  usb.on('stopped', event => {
    if (receiver !== usb) return;
    receiver = null; rtlInfo = null; resetDsp(); stopScan();
    broadcast({ type: 'status', status: status(), message: event.message || 'RTL-SDR USB disconnected.' });
  });
  try {
    rtlInfo = await usb.start({ libraryPath: settings.rtlLibraryPath, deviceIndex: settings.deviceIndex,
      deviceSerial: settings.deviceSerial, frequency: freq, sampleRate: rate, gain,
      ppm: settings.ppm, rtlAgc: settings.rtlAgc, directSampling: settings.directSampling,
      tunerBandwidth: settings.tunerBandwidth, biasTee: settings.biasTee });
    sampleRate = rtlInfo.sampleRate; activeGain = rtlInfo.gain;
    setSettings({ sampleRate });
    broadcast({ type: 'status', status: status() });
    return status();
  } catch (error) {
    if (receiver === usb) receiver = null;
    rtlInfo = null; await usb.close();
    throw error;
  }
}
async function stopReceiver({ keepScan = false } = {}) {
  const usb = receiver; receiver = null;
  if (!keepScan) stopScan();
  if (usb) await usb.close();
  rtlInfo = null; resetDsp();
  broadcast({ type: 'status', status: status() });
}

function trunkedControlPlan(channelList, channelIds) {
  if (!Array.isArray(channelIds) || !channelIds.length) throw new Error('Select at least one trunked system to scan.');
  const ids = [...new Set(channelIds.map(String))];
  const systems = ids.map(id => channelList.find(channel => channel.id === id));
  if (systems.some(channel => !channel)) throw new Error('A selected trunked system no longer exists. Refresh the library and select again.');
  if (systems.some(channel => channel.kind !== 'trunked')) throw new Error('Select trunked systems only. Trunked and conventional scans use separate receiver modes.');
  const entries = [];
  for (const channel of systems) {
    const sites = Array.isArray(channel.sites) ? channel.sites : [];
    if (!sites.length) throw new Error(`“${channel.name}” has no saved sites to scan.`);
    for (const site of sites) {
      const frequencies = Array.isArray(site.frequencies) ? site.frequencies : [];
      const controls = frequencies.filter(item => ['d', 'a'].includes(item.use));
      const candidates = controls.length ? controls : [frequencies[0] || { frequency: channel.frequency, use: 'd' }];
      const seen = new Set();
      for (const item of candidates) {
        const frequency = validFrequency(item.frequency);
        if (seen.has(frequency)) continue;
        seen.add(frequency);
        entries.push({ channel, site, frequency, role: item.use === 'a' ? 'alternate' : 'control' });
        if (entries.length > 256) throw new Error('Scan up to 256 saved trunked control frequencies at a time.');
      }
    }
  }
  if (!entries.length) throw new Error('The selected trunked systems have no saved control frequencies.');
  const decoderProfiles = new Set(entries.map(({ channel }) => JSON.stringify({ flags: decoderFlags(channel, { trunked: true }), talkgroupFilterEnabled: channel.talkgroupFilterEnabled === true })));
  if (decoderProfiles.size > 1) throw new Error('Keep one decoder profile and talkgroup-filter mode per scan so the tuner can stay open between control frequencies.');
  return { ids, systems, entries };
}

function writeTrunkedDecoderMaps(trunked, site, frequency, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const safe = value => String(value ?? '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48) || 'site';
  const stem = `${safe(trunked.name)}-${safe(trunked.id)}-${safe(site.id)}-${frequency}`;
  const channelMap = path.join(folder, `${stem}-channels.csv`);
  const groupMap = path.join(folder, `${stem}-groups.csv`);
  const mapRows = channelMapRows(site, frequency);
  const groupRows = ['DEC,Mode(A- Allow; B - Block; DE - Digital Enc),Name of Group,Tag (do not delete this line or it will not import properly)'];
  const knownGroups = new Map((trunked.talkgroups || []).map(group => [String(group.id), group]));
  const selectedGroups = trunked.talkgroupFilterEnabled
    ? trunked.talkgroupIds.map(id => knownGroups.get(id) || { id, alpha: `Talkgroup ${id}` })
    : trunked.talkgroups || [];
  for (const group of selectedGroups) if (!group.encrypted && group.id !== undefined && group.id !== null && String(group.id) !== '') groupRows.push([group.id,'A',group.alpha || group.description || `Talkgroup ${group.id}`,`RR ${trunked.systemId}`].map(csvCell).join(','));
  fs.writeFileSync(channelMap, mapRows.join('\r\n') + '\r\n', 'utf8');
  fs.writeFileSync(groupMap, groupRows.join('\r\n') + '\r\n', 'utf8');
  return { channelMap, groupMap };
}

function trunkedScanSnapshot(scan = trunkedScanner) {
  if (!scan) return null;
  const entry = scan.current;
  return { active: scan.active, engine: 'trunked', channelIds: scan.channelIds, channelCount: scan.systemCount,
    controlCount: scan.entries.length, dwellMs: scan.dwellMs, holdOnSignal: scan.holdOnSignal, holdMs: scan.holdMs, index: scan.index, total: scan.entries.length,
    hops: scan.hops, holding: scan.holding, paused: scan.paused, activity: scan.activity,
    current: entry ? { channelId: entry.channel.id, systemName: entry.channel.name, siteId: entry.site.id,
      siteName: entry.site.name, frequency: entry.frequency, role: entry.role, mode: entry.channel.mode } : null,
    channel: entry ? { id: entry.channel.id, name: entry.channel.name, frequency: entry.frequency, mode: entry.channel.mode } : null };
}

async function stopTrunkedScan({ error = '', stopDecoder = true } = {}) {
  const scan = trunkedScanner;
  if (!scan) return;
  trunkedScanner = null; scan.active = false;
  if (scan.timer) clearTimeout(scan.timer);
  if (scan.resumeTimer) clearTimeout(scan.resumeTimer);
  scan.timer = null;
  scan.resumeTimer = null;
  try { if (stopDecoder) await stopDigital({ keepTrunkedScan: true }); }
  finally {
    if (scan.mapDirectory && path.dirname(scan.mapDirectory) === DATA_DIR && path.basename(scan.mapDirectory).startsWith('trunked-scan-')) {
      try { fs.rmSync(scan.mapDirectory, { recursive: true, force: true }); } catch {}
    }
    if (error) broadcast({ type: 'scan-error', message: error });
    broadcast({ type: 'status', status: status() });
  }
}

async function retuneTrunkedScanEntry(scan, entry) {
  if (!digitalSession?.active) throw new Error('The integrated decoder session is not available for in-place retuning.');
  const maps = writeTrunkedDecoderMaps(entry.channel, entry.site, entry.frequency, scan.mapDirectory);
  await digitalSession.request('import_channel_map', { value: maps.channelMap });
  await digitalSession.request('import_group_list', { value: maps.groupMap });
  await digitalSession.retune(entry.frequency);
}

async function startTrunkedScanEntry(scan, index) {
  if (!scan.active || trunkedScanner !== scan) return;
  scan.busy = true; scan.activity = 'Changing control channel';
  try {
    if (!scan.active || trunkedScanner !== scan) return;
    if (scan.resumeTimer) clearTimeout(scan.resumeTimer);
    scan.resumeTimer = null;
    const entry = scan.entries[index];
    scan.index = index; scan.current = entry; scan.activity = 'Starting decoder'; scan.holding = false; scan.callActive = false;
    activeFrequency = entry.frequency; appMode = entry.channel.mode; selectedChannelId = entry.channel.id;
    broadcast({ type: 'status', status: status() });
    if (digitalSession?.active) await retuneTrunkedScanEntry(scan, entry);
    else await startDigital({ channelId: entry.channel.id, siteId: entry.site.id, controlFrequency: entry.frequency, trunkedScan: true });
    if (!scan.active || trunkedScanner !== scan) {
      await stopDigital({ keepTrunkedScan: true });
      return;
    }
    scan.activity = scan.paused ? 'Paused on current control channel' : scan.holding ? 'Voice call active' : 'Monitoring control channel'; scan.hops++;
    if (!scan.holding && !scan.paused) scan.timer = setTimeout(() => { void advanceTrunkedScan(scan).catch(() => {}); }, scan.dwellMs);
    broadcast({ type: 'status', status: status() });
  } catch (error) {
    if (trunkedScanner === scan) await stopTrunkedScan({ error: scan.hops ? error.message : '', stopDecoder: true });
    throw error;
  } finally { scan.busy = false; }
}

async function advanceTrunkedScan(scan = trunkedScanner, force = false) {
  if (!scan?.active || trunkedScanner !== scan || (scan.paused && !force) || scan.busy) return;
  if (scan.timer) clearTimeout(scan.timer);
  if (scan.resumeTimer) clearTimeout(scan.resumeTimer);
  scan.timer = null;
  scan.resumeTimer = null;
  try { await startTrunkedScanEntry(scan, (scan.index + 1) % scan.entries.length); } catch {}
}

function setTrunkedScanPaused(scan, paused) {
  if (!scan?.active || trunkedScanner !== scan) throw new Error('Start a trunked scan before pausing it.');
  if (scan.paused === paused) return;
  scan.paused = paused;
  if (scan.timer) clearTimeout(scan.timer);
  if (scan.resumeTimer) clearTimeout(scan.resumeTimer);
  scan.timer = null;
  scan.resumeTimer = null;
  if (paused) {
    scan.activity = scan.holding ? scan.callActive ? 'Paused during voice call' : 'Paused after voice call' : 'Paused on current control channel';
  } else if (!scan.busy && scan.holding && scan.callActive) {
    scan.activity = 'Voice call active';
  } else if (!scan.busy && scan.holding) {
    scan.activity = 'Call ended · waiting to resume';
    scan.resumeTimer = setTimeout(() => {
      if (trunkedScanner !== scan || !scan.active || scan.paused) return;
      scan.holding = false; scan.resumeTimer = null; void advanceTrunkedScan(scan);
    }, scan.holdMs);
  } else if (!scan.busy) {
    scan.activity = 'Resuming scan';
    void advanceTrunkedScan(scan);
  }
  broadcast({ type: 'status', status: status() });
}

async function startTrunkedScan(body) {
  if (settings.digitalEngine === 'external') throw new Error('Trunked site scanning currently requires the integrated DSD-neo decoder. Choose Integrated DSD-neo in Settings.');
  if (!digitalRuntime().available) throw new Error('The integrated DSD-neo decoder is unavailable.');
  const plan = trunkedControlPlan(channels, body.channelIds);
  const requested = Number(body.dwellMs ?? 2000);
  if (!Number.isInteger(requested) || requested < 1000 || requested > 120000) throw new Error('Choose a trunked site dwell time from 1 to 120 seconds.');
  if (trunkedScanner) await stopTrunkedScan();
  await stopHd();
  if (digitalProcess || digitalSession?.active) await stopDigital();
  stopScan();
  const scan = { active: true, channelIds: plan.ids, systemCount: plan.systems.length, entries: plan.entries,
    dwellMs: requested, holdOnSignal: body.holdOnSignal !== false, holdMs: Math.max(250, Math.min(10000, Number(body.holdMs) || 1500)),
    mapDirectory: fs.mkdtempSync(path.join(DATA_DIR, 'trunked-scan-')),
    index: -1, hops: 0, holding: false, paused: false, callActive: false, activity: 'Starting decoder', current: null, busy: false, timer: null, resumeTimer: null };
  trunkedScanner = scan;
  try {
    await startTrunkedScanEntry(scan, 0);
    if (body.channelIds !== undefined) setSettings({ scanChannelIds: plan.ids });
    const snapshot = trunkedScanSnapshot(scan);
    return { ...snapshot, scan: snapshot };
  } catch (error) {
    if (trunkedScanner === scan) await stopTrunkedScan({ stopDecoder: false });
    throw error;
  }
}

function canRetuneDigitalMemory(channel) {
  if (!digitalSession?.active || settings.digitalEngine === 'external' || !activeDigitalConfig) return false;
  try {
    return JSON.stringify(decoderFlags(activeDigitalConfig, { trunked: false })) === JSON.stringify(decoderFlags(channel, { trunked: false }));
  } catch { return false; }
}

async function startHybridScan(plan, body) {
  const session = new MemoryScanner(plan, {
    tune: async channel => {
      if (DIGITAL_MODES.has(channel.mode)) {
        if (receiver) await stopReceiver({ keepScan: true });
        if (canRetuneDigitalMemory(channel)) {
          await digitalSession.retune(channel.frequency);
          activeFrequency = channel.frequency; appMode = channel.mode; selectedChannelId = channel.id;
        } else {
          if (digitalProcess || digitalSession?.active) await stopDigital();
          await startDigital({ memoryId: channel.id, hybridScan: true });
        }
      } else {
        if (digitalProcess || digitalSession?.active) await stopDigital();
        if (!receiver?.connected) {
          await startReceiver({ frequency: channel.frequency, mode: channel.mode, gain: settings.tunerGain || 0, keepScan: true });
        } else {
          const usb = receiver;
          await usb.command('frequency', channel.frequency);
          if (!usb.connected || receiver !== usb) throw new Error('The USB receiver disconnected during scanning.');
          activeFrequency = channel.frequency; appMode = channel.mode; selectedChannelId = channel.id; resetDsp();
        }
      }
    },
    event: (type, scan) => broadcast({ type, channel: scan.channel, scan, index: session.index, total: plan.channels.length }),
    error: error => { if (scanner === session) { scanner = null; broadcast({ type: 'scan-error', message: error.message }); broadcast({ type: 'status', status: status() }); } }
  });
  scanner = session;
  try {
    const scan = await session.start();
    if (!scan.active) throw new Error('The mixed memory scanner could not start. Check the USB receiver and digital decoder.');
    if (body.channelIds !== undefined) setSettings({ scanChannelIds: plan.channelIds });
    broadcast({ type: 'status', status: status() });
    return { ...scan, scan };
  } catch (error) {
    if (scanner === session) stopScan();
    if (digitalProcess || digitalSession?.active) await stopDigital();
    if (receiver) await stopReceiver();
    throw error;
  }
}

async function startScan(body = {}) {
  if (hdStarting) throw new Error('Wait for HD Radio to finish starting.');
  if (digitalStarting) throw new Error('Wait for the digital decoder to finish starting.');
  if (body.channelIds !== undefined) {
    const selected = Array.isArray(body.channelIds) ? body.channelIds.map(id => channels.find(channel => channel.id === String(id))).filter(Boolean) : [];
    if (selected.some(channel => channel.kind === 'trunked')) return startTrunkedScan(body);
  }
  const plan = scanPlan(channels, body);
  if (trunkedScanner) await stopTrunkedScan();
  await stopHd();
  if (digitalProcess || digitalSession?.active) await stopDigital();
  stopScan();
  if (plan.engine === 'hybrid') return startHybridScan(plan, body);
  if (plan.engine === 'digital' || plan.engine === 'dsd') {
    const result = await startDigital({ scanMemories: true, scanPlan: plan, rapid: plan.rapid });
    if (body.channelIds !== undefined) setSettings({ scanChannelIds: plan.channelIds });
    return { ...result.scan, scan: result.scan };
  }
  if (!receiver?.connected) await startReceiver({ frequency: plan.channels[0].frequency, mode: plan.channels[0].mode, gain: settings.tunerGain || 0 });
  const usb = receiver;
  const session = new MemoryScanner(plan, {
    tune: async channel => {
      if (!usb.connected || receiver !== usb) throw new Error('The USB receiver disconnected during scanning.');
      await usb.command('frequency', channel.frequency);
      if (scanner !== session || !session.active) return;
      selectedChannelId = channel.id; activeFrequency = channel.frequency; appMode = channel.mode; resetDsp();
    },
    event: (type, scan) => broadcast({ type, channel: scan.channel, scan, index: session.index, total: plan.channels.length }),
    error: error => { if (scanner === session) { scanner = null; broadcast({ type: 'scan-error', message: error.message }); broadcast({ type: 'status', status: status() }); } }
  });
  scanner = session;
  const scan = await session.start();
  if (!scan.active) throw new Error('The memory scanner could not start. Check the USB receiver.');
  if (body.channelIds !== undefined) setSettings({ scanChannelIds: plan.channelIds });
  broadcast({ type: 'status', status: status() });
  return { ...scan, scan };
}
function stopScan() { const current = scanner; scanner = null; current?.stop(); broadcast({ type: 'status', status: status() }); }

async function startWsjtBridge(port) {
  const nextPort = Number(port ?? settings.wsjtPort ?? 2237);
  if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) throw new Error('Choose a WSJT-X UDP port from 1024 to 65535.');
  if (wsjtStarting) throw new Error('Wait for the WSJT-X bridge to finish starting.');
  if (wsjtReady && wsjtPort === nextPort) return { active: true, port: wsjtPort };
  stopWsjtBridge();
  const generation = wsjtGeneration, socket = dgram.createSocket('udp4'); wsjtSocket = socket; wsjtPort = nextPort; wsjtStarting = true;
  socket.on('message', data => {
    if (wsjtSocket !== socket || !wsjtReady) return;
    const decode = parseWsjtPacket(data, wsjtSessions); if (!decode) return;
    recentDecodes.push(decode); recentDecodes = recentDecodes.slice(-100);
    broadcast({ type: 'ft8', decode });
  });
  socket.on('error', err => { if (wsjtSocket === socket) { broadcast({ type: 'log', source: 'WSJT-X', message: err.message }); stopWsjtBridge(); } });
  try {
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); socket.off('listening', ready); socket.off('error', failed); socket.off('close', closed); error ? reject(error) : resolve(); };
      const ready = () => finish(), failed = error => finish(error), closed = () => finish(new Error('WSJT-X bridge start was cancelled.'));
      const timer = setTimeout(() => finish(new Error('WSJT-X bridge could not bind its UDP port.')), 5000);
      socket.once('listening', ready); socket.once('error', failed); socket.once('close', closed);
      try { socket.bind(nextPort, '127.0.0.1'); } catch (error) { finish(error); }
    });
    if (generation !== wsjtGeneration || wsjtSocket !== socket) throw new Error('WSJT-X bridge start was cancelled.');
    setSettings({ wsjtPort: nextPort }); wsjtReady = true; wsjtStarting = false;
    broadcast({ type: 'status', status: status() }); return { active: true, port: nextPort };
  } catch (error) { if (wsjtSocket === socket) stopWsjtBridge(); throw error; }
}
function stopWsjtBridge() { ++wsjtGeneration; const socket = wsjtSocket; wsjtSocket = null; wsjtPort = null; wsjtReady = false; wsjtStarting = false; try { socket?.close(); } catch {} wsjtSessions.clear(); broadcast({ type: 'status', status: status() }); }

async function soapCall(method, args) {
  const esc = xmlEscape;
  const encodeAuth = auth => `<authInfo xsi:type="tns:authInfo"><username xsi:type="xsd:string">${esc(auth.username)}</username><password xsi:type="xsd:string">${esc(auth.password)}</password><appKey xsi:type="xsd:string">${esc(auth.appKey)}</appKey><version xsi:type="xsd:string">latest</version><style xsi:type="xsd:string">rpc</style></authInfo>`;
  const encoded = args.map(([name, value, type]) => name === 'authInfo' ? encodeAuth(value) : `<${name} xsi:type="xsd:${type}">${esc(value)}</${name}>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="http://api.radioreference.com/soap2"><SOAP-ENV:Body SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><tns:${method}>${encoded}</tns:${method}></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  const response = await fetch('https://api.radioreference.com/soap2/index.php', {
    method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', 'SOAPAction': `"http://api.radioreference.com/soap2#${method}"` },
    body: xml, signal: AbortSignal.timeout(25000)
  });
  const text = await response.text();
  if (!response.ok && !text.includes('Fault')) throw new Error(`RadioReference returned HTTP ${response.status}.`);
  const root = parseXml(text);
  const fault = firstDescendant(root, 'faultstring');
  if (fault) throw new Error(`RadioReference: ${nodeText(fault)}`);
  return root;
}
function xmlEscape(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function xmlUnescape(value) { return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&'); }
function parseXml(source) {
  const root = { name: '#root', children: [], text: '' }, stack = [root];
  const tokens = source.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<')) {
      const match = token.match(/^<([^\s/>]+)/); if (!match) continue;
      const node = { name: match[1].split(':').pop(), attrs: token, children: [], text: '' };
      stack.at(-1).children.push(node);
      if (!token.endsWith('/>')) stack.push(node);
      continue;
    }
    stack.at(-1).text += xmlUnescape(token.trim());
  }
  return root;
}
function nodeText(node) { return [node.text || '', ...node.children.map(nodeText)].join('').trim(); }
function firstDescendant(node, name) { if (node.name === name) return node; for (const child of node.children) { const found = firstDescendant(child, name); if (found) return found; } return null; }
function descendants(node, name, result = []) { for (const child of node.children) { if (child.name === name) result.push(child); descendants(child, name, result); } return result; }
function childText(node, name) { const child = node.children.find(c => c.name === name); return child ? nodeText(child) : ''; }
function returnItems(root) {
  const ret = firstDescendant(root, 'return');
  if (!ret) return [];
  const items = ret.children.filter(c => c.name === 'item' || c.children.length);
  return items.length ? items : [ret];
}
function parseFrequency(raw) {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1_000_000);
}
function radioReferenceModeNames(root) {
  const modes = new Map();
  for (const item of returnItems(root)) {
    const id = childText(item, 'mode').trim(), name = childText(item, 'modeName').trim();
    if (/^\d+$/.test(id) && name) modes.set(id, name);
  }
  return modes;
}
function protocolFromRadioReference(mode, description = '') {
  const text = `${mode} ${description}`.toUpperCase();
  if (/\b(?:YSF|C4FM|FUSION)\b|SYSTEM\s+FUSION|YAESU(?:\s+SYSTEM)?\s+FUSION/.test(text)) return { mode: 'YSF' };
  if (/\bM17\b/.test(text)) return { mode: 'M17' };
  if (/\bP25\b|PROJECT\s*25/.test(text)) return { mode: 'P25' };
  if (/\bDMR\b|MOTOTRBO/.test(text)) return { mode: 'DMR' };
  // NXDN48/NXDN96 are contiguous word characters, so `\bNXDN\b` misses them.
  if (/\bNXDN(?:\s*(?:48|96))?\b|\bNEXEDGE\b/.test(text)) {
    return { mode: 'NXDN', nxdnMode: /\bNXDN\s*96\b|\b9600\s*(?:BPS|BAUD)\b/.test(text) ? 'NXDN96' : 'NXDN48' };
  }
  if (/D-?STAR|\bDV\b/.test(text)) return { mode: 'D-STAR' };
  if (/\bAM\b/.test(text)) return { mode: 'AM' };
  if (/\bUSB\b/.test(text)) return { mode: 'USB' };
  if (/\bLSB\b/.test(text)) return { mode: 'LSB' };
  if (/\bWFM\b/.test(text)) return { mode: 'WFM' };
  return { mode: 'NFM' };
}
async function importRadioReference(body) {
  const auth = { appKey: String(body.appKey || '').trim(), username: String(body.username || '').trim(), password: String(body.password || '') };
  if (!auth.appKey || !auth.username || !auth.password) throw new Error('Enter your approved API key and your own RadioReference Premium credentials.');
  if (body.kind === 'conventional') return importRadioReferenceCounty(body, auth);
  const systemId = Math.trunc(Number(body.systemId));
  if (!systemId || systemId < 1) throw new Error('Enter a RadioReference trunked system ID.');
  const authArg = ['authInfo', auth];
  const [detailsXml, sitesXml, talkgroupsXml] = await Promise.all([
    soapCall('getTrsDetails', [['sid', systemId, 'int'], authArg]),
    soapCall('getTrsSites', [['sid', systemId, 'int'], authArg]),
    soapCall('getTrsTalkgroups', [['sid', systemId, 'int'], ['tgCid', 0, 'int'], ['tgTag', 0, 'int'], ['tgDec', 0, 'int'], authArg])
  ]);
  const details = firstDescendant(detailsXml, 'return');
  const sites = returnItems(sitesXml);
  const talkgroups = returnItems(talkgroupsXml);
  const name = childText(details, 'sName') || `RadioReference system ${systemId}`;
  const trunked = {
    id: `rr-${systemId}-${Date.now()}`, kind: 'trunked', systemId,
    name, mode: 'P25', enabled: false, source: 'RadioReference',
    systemCode: childText(firstDescendant(details, 'sysid') || details || { children: [] }, 'sysid'),
    sites: [], talkgroups: []
  };
  for (const site of sites) {
    const siteId = childText(site, 'siteId');
    const freqParent = site.children.find(c => c.name === 'siteFreqs');
    const freqs = freqParent ? freqParent.children.filter(c => c.children.length).map(freq => ({
      lcn: childText(freq, 'lcn'), frequency: parseFrequency(childText(freq, 'freq')), use: childText(freq, 'use'),
      colorCode: childText(freq, 'colorCode'), channelId: childText(freq, 'ch_id')
    })).filter(f => f.frequency && f.frequency >= 10000 && f.frequency <= 1_766_000_000) : [];
    trunked.sites.push({ id: siteId, name: childText(site, 'siteDescr') || `Site ${siteId}`, modulation: childText(site, 'siteModulation'), nac: childText(site, 'nac'), frequencies: freqs });
  }
  for (const tg of talkgroups) {
    const id = childText(tg, 'tgDec');
    if (!id) continue;
    trunked.talkgroups.push({ id, alpha: childText(tg, 'tgAlpha'), description: childText(tg, 'tgDescr'), mode: childText(tg, 'tgMode'), encrypted: childText(tg, 'enc') === '2', categoryId: childText(tg, 'tgCid') });
  }
  Object.assign(trunked, importedProtocol([name, childText(details, 'sTypeDescr'), childText(details, 'sType'), ...trunked.sites.map(site => site.modulation)].join(' '), trunked.talkgroups));
  const selectedSite = body.siteId ? trunked.sites.find(s => String(s.id) === String(body.siteId)) : trunked.sites[0];
  if (selectedSite) trunked.frequency = selectedSite.frequencies.find(f => f.use === 'd')?.frequency || selectedSite.frequencies[0]?.frequency || 0;
  const normalized = normalizeChannel(trunked, false); channels.push(normalized); writeJson(CHANNELS_FILE, channels);
  return { channel: normalized, importedSites: trunked.sites.length, importedTalkgroups: trunked.talkgroups.length };
}

function xmlArrayItems(node) { return node ? node.children.filter(child => child.children.length > 0) : []; }
async function limitedMap(items, limit, mapper) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const index = next++; if (index >= items.length) return; results[index] = await mapper(items[index], index); }
  }));
  return results;
}
async function importRadioReferenceCounty(body, auth) {
  const zip = String(body.zip || '').replace(/\D/g, '').slice(0, 5);
  if (zip.length !== 5) throw new Error('Enter a 5-digit US ZIP code to look up conventional frequencies.');
  const authArg = ['authInfo', auth];
  const [zipXml, modesXml] = await Promise.all([
    soapCall('getZipcodeInfo', [['zipcode', Number(zip), 'int'], authArg]),
    soapCall('getMode', [['mode', 0, 'int'], authArg])
  ]);
  const modeNames = radioReferenceModeNames(modesXml);
  const zipInfo = firstDescendant(zipXml, 'return');
  const countyId = Number(childText(zipInfo, 'ctid'));
  if (!countyId) throw new Error('RadioReference did not return a county for that ZIP code.');
  const countyXml = await soapCall('getCountyInfo', [['ctid', countyId, 'int'], authArg]);
  const county = firstDescendant(countyXml, 'return');
  const countyName = childText(county, 'countyName') || 'Selected county';
  const city = childText(zipInfo, 'city');
  const tasks = [];
  const catsNode = county?.children.find(c => c.name === 'cats');
  for (const cat of xmlArrayItems(catsNode)) {
    const catName = childText(cat, 'cName') || 'County';
    for (const subcat of xmlArrayItems(cat.children.find(c => c.name === 'subcats'))) {
      const id = Number(childText(subcat, 'scid'));
      if (id) tasks.push({ id, group: catName, subcategory: childText(subcat, 'scName') });
    }
  }
  const agencyNodes = xmlArrayItems(county?.children.find(c => c.name === 'agencyList'));
  const agencies = agencyNodes.map(a => Number(childText(a, 'aid'))).filter(Number.isFinite);
  const agencyInfos = await limitedMap(agencies, 3, async id => {
    const xml = await soapCall('getAgencyInfo', [['aid', id, 'int'], authArg]);
    const agency = firstDescendant(xml, 'return');
    const agencyName = childText(agency, 'agencyName') || 'Agency';
    const agencyCats = xmlArrayItems(agency?.children.find(c => c.name === 'cats'));
    for (const cat of agencyCats) {
      for (const subcat of xmlArrayItems(cat.children.find(c => c.name === 'subcats'))) {
        const scid = Number(childText(subcat, 'scid'));
        if (scid) tasks.push({ id: scid, group: agencyName, subcategory: childText(subcat, 'scName') });
      }
    }
  });
  const limitedTasks = tasks.slice(0, 180);
  const frequencyLists = await limitedMap(limitedTasks, 4, async item => {
    const xml = await soapCall('getSubcatFreqs', [['scid', item.id, 'int'], authArg]);
    return { item, frequencies: returnItems(xml) };
  });
  const additions = [];
  let updated = 0;
  const existingByKey = new Map(channels.filter(c => c.kind !== 'trunked').map(c => [`${c.frequency}:${c.name.toLowerCase()}`, c]));
  for (const result of frequencyLists) {
    for (const freq of result.frequencies) {
      const mhz = Number(childText(freq, 'out'));
      if (!Number.isFinite(mhz) || mhz <= 0 || childText(freq, 'enc') === '2') continue;
      const frequency = Math.round(mhz * 1e6);
      if (frequency < 10000 || frequency > 1_766_000_000) continue;
      const name = (childText(freq, 'alpha') || childText(freq, 'callsign') || childText(freq, 'descr') || result.item.subcategory || 'RadioReference frequency').slice(0, 80);
      const key = `${frequency}:${name.toLowerCase()}`;
      const notes = [childText(freq, 'descr'), childText(freq, 'tone'), childText(freq, 'tg') ? `TG ${childText(freq, 'tg')}` : '', childText(freq, 'slot') ? `Slot ${childText(freq, 'slot')}` : ''].filter(Boolean).join(' · ').slice(0,300);
      const rawMode = childText(freq, 'mode').trim();
      const rrMode = modeNames.get(rawMode) || rawMode;
      const description = [childText(freq, 'alpha'), childText(freq, 'callsign'), childText(freq, 'descr')].filter(Boolean).join(' ');
      const imported = normalizeChannel({ name, frequency, ...protocolFromRadioReference(rrMode, description), kind: 'conventional', group: result.item.group, notes, source: 'RadioReference' });
      const existing = existingByKey.get(key);
      if (existing) {
        const protocolChanged = existing.mode !== imported.mode || (imported.mode === 'NXDN' && (existing.nxdnMode || 'NXDN48') !== imported.nxdnMode);
        if (existing.source === 'RadioReference' && DIGITAL_MODES.has(imported.mode) && protocolChanged) {
          Object.assign(existing, normalizeChannel({ ...existing, mode: imported.mode, ...digitalOptions(imported) }, false));
          updated++;
        }
        continue;
      }
      existingByKey.set(key, imported);
      additions.push(imported);
      if (additions.length >= 500) break;
    }
    if (additions.length >= 500) break;
  }
  if (!additions.length && !updated) throw new Error(`No conventional frequencies were available for ${city ? `${city}, ` : ''}${countyName}.`);
  channels.push(...additions); writeJson(CHANNELS_FILE, channels);
  return { kind: 'conventional', imported: additions.length, updated, county: countyName, city };
}

async function stopDigital({ keepTrunkedScan = false } = {}) {
  if (!keepTrunkedScan && trunkedScanner) {
    const scan = trunkedScanner; trunkedScanner = null; scan.active = false;
    if (scan.timer) clearTimeout(scan.timer);
    scan.timer = null;
  }
  digitalGeneration++;
  const session = digitalSession;
  if (session) {
    await session.stop();
    lastDigitalState = session.snapshot();
    if (digitalSession === session) digitalSession = null;
  }
  const child = digitalProcess; digitalProcess = null; digitalScan = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      let finished = false;
      const done = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 1500); timer.unref?.();
      child.once('exit', done);
      try { child.kill(); } catch { done(); }
    });
  }
  broadcast({ type: 'status', status: status() });
}
async function stopHd() {
  hdGeneration++;
  const session = hdSession;
  if (session) {
    await session.stop(); lastHdState = session.snapshot();
    if (hdSession === session) hdSession = null;
    broadcast({ type: 'status', status: status() });
  }
}
async function startHd(body = {}) {
  if (hdStarting || digitalStarting) throw new Error('Wait for the current receiver to finish starting.');
  const memory = body.memoryId ? channels.find(channel => channel.id === body.memoryId && channel.mode === 'HD' && channel.kind !== 'trunked') : null;
  if (body.memoryId && !memory) throw new Error('Choose a saved HD Radio memory.');
  const frequency = validFrequency(memory?.frequency ?? body.frequency ?? activeFrequency);
  const program = hdProgram(memory?.hdProgram ?? body.program ?? 0);
  hdBandForFrequency(frequency);
  if (!hdRuntime().available) throw new Error('The bundled HD Radio library is unavailable. Restore native/hd-radio.');
  if (Number(settings.directSampling)) throw new Error('Choose Quadrature sampling in Hardware settings before receiving HD Radio.');
  hdStarting = true; const generation = ++hdGeneration;
  try {
    const previous = hdSession;
    if (previous) { await previous.stop(); if (hdSession === previous) hdSession = null; }
    stopScan(); await stopReceiver(); await stopDigital();
    if (generation !== hdGeneration) throw new Error('HD Radio start cancelled.');
    const session = new HdRadio({ frequency, program, settings: { ...settings } }); hdSession = session;
    activeFrequency = frequency; appMode = 'HD'; sampleRate = 1488375; selectedChannelId = memory?.id || null;
    session.on('audio', ({ samples, level }) => {
      if (hdSession !== session || !session.active) return;
      const header = Buffer.alloc(8); header.write('HDA1'); header.writeUInt32LE(2, 4);
      const frame = Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
      for (const client of clients) sendBinary(client, frame);
      broadcast({ type: 'meter', level, sampleRate: 48000 });
    });
    session.on('spectrum', frame => { if (hdSession === session && session.active) broadcastSpectrum(frame); });
    session.on('state', hd => {
      if (hdSession !== session) return;
      if (hd.info) activeGain = hd.info.gain;
      broadcast({ type: 'hd-state', hd });
      if (!session.active) broadcast({ type: 'status', status: status() });
    });
    session.on('failure', error => { if (hdSession === session) { broadcast({ type: 'hd-error', message: error.message }); broadcast({ type: 'status', status: status() }); } });
    await session.start();
    if (generation !== hdGeneration) { await session.stop(); throw new Error('HD Radio start cancelled.'); }
  } catch (error) {
    if (hdSession) { await hdSession.stop(); lastHdState = hdSession.snapshot(); hdSession = null; }
    throw error;
  } finally { hdStarting = false; broadcast({ type: 'status', status: status() }); }
  // Take the HTTP snapshot after clearing the startup flag. Returning it from
  // inside try can overwrite the final WebSocket status with hdStarting=true.
  return status();
}
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
async function startDigital(body) {
  if (hdStarting) throw new Error('Wait for HD Radio to finish starting.');
  if (trunkedScanner?.active && !body.trunkedScan) throw new Error('Stop the trunked site scan before starting another decoder.');
  if (digitalStarting || digitalProcess || digitalSession?.active) throw new Error('Stop the current digital session before starting another decoder.');
  digitalStarting = true;
  const generation = ++digitalGeneration;
  try { return await launchDigital(body, generation); } finally { digitalStarting = false; broadcast({ type: 'status', status: status() }); }
}
async function launchDigital(body, generation) {
  const integrated = settings.digitalEngine !== 'external';
  if (integrated && !digitalRuntime().available) throw new Error('The bundled digital decoder is unavailable. Restore the native/digital application files.');
  const binary = String(body.path || settings.dsdPath || '').trim();
  const trunked = body.channelId ? channels.find(c => c.id === body.channelId && c.kind === 'trunked') : null;
  if (body.channelId && !trunked) throw new Error('Select a saved trunked system first.');
  const memory = body.memoryId ? channels.find(c => c.id === body.memoryId && c.kind !== 'trunked') : null;
  if (body.memoryId && !memory) throw new Error('The selected digital memory no longer exists.');
  const selectedSite = trunked ? (trunked.sites.find(s => String(s.id) === String(body.siteId)) || trunked.sites[0]) : null;
  if (trunked && !selectedSite) throw new Error('This trunked system has no imported sites.');
  const plan = body.scanMemories ? body.scanPlan || scanPlan(channels, { channelIds: body.channelIds || channels.filter(channel => channel.kind !== 'trunked' && channel.enabled !== false && DIGITAL_MODES.has(channel.mode)).map(channel => channel.id), rapid: body.rapid === true }) : null;
  if (plan && !['digital', 'dsd'].includes(plan.engine)) throw new Error('Select digital conventional memories for the digital scanner.');
  if (plan?.engine === 'dsd' && !integrated) throw new Error('NFM, AM, WFM, and digital mixed scans require the bundled DSD-neo decoder. Select Integrated DSD-neo in Settings.');
  if (!integrated && !body.path && !settings.dsdPath) throw new Error('Select the DSD-FME executable in Settings first.');
  const config = plan?.engine === 'dsd' ? resolveProtocol('P25') : plan?.profile || resolveProtocol(body.protocol, trunked || memory || {});
  const protocol = config.mode;
  const decoderLabel = plan?.engine === 'dsd' ? 'DSD-neo mixed-mode scan' : protocolLabel(config);
  const freq = validFrequency(plan ? plan.channels[0].frequency : trunked ? (body.controlFrequency || selectedSite.frequencies.find(f => f.use === 'd')?.frequency || selectedSite.frequencies[0]?.frequency || trunked.frequency) : memory?.frequency || body.frequency || activeFrequency);
  const flags = plan?.engine === 'dsd' ? [] : plan?.profile.flags || decoderFlags(config, { trunked: Boolean(trunked) });
  let deviceIndex = Number(settings.deviceIndex) || 0;
  if (integrated && settings.deviceSerial) {
    const found = await listUsbDevices(settings.rtlLibraryPath);
    const selected = found.devices.find(device => device.serial === settings.deviceSerial);
    if (!selected) throw new Error(`The selected RTL-SDR (${settings.deviceSerial}) is not attached.`);
    deviceIndex = selected.index;
  }
  if (integrated && Number(settings.directSampling)) throw new Error('DSD-neo scanning requires quadrature sampling. Choose Quadrature in USB hardware settings.');
  const requestedGain = integrated ? Math.min(49, Math.round(Number(settings.tunerGain || 0) / 10)) : Number(settings.tunerGain || 0) / 10;
  const scanBandwidth = plan?.channels.some(channel => channel.mode === 'WFM') ? 256 : 48;
  const input = `rtl:${deviceIndex}:${freq}:${requestedGain}:${Number(settings.ppm) || 0}:${integrated ? scanBandwidth : protocol === 'NXDN' && config.nxdnMode !== 'NXDN96' ? 8 : 12}:0:2`;
  const args = ['-i', input + (integrated ? `:bias=${settings.biasTee ? 'on' : 'off'}` : ''), ...flags];
  if (integrated && plan) {
    const voiceWindowMs = Math.max(100, plan.dwellMs || 0);
    args.push('--scan-voice-only', '--scan-voice-qualify-ms', String(voiceWindowMs), '--scan-voice-hold-ms', String(voiceWindowMs));
  }
  let scanningCount = 0;
  if (trunked) {
    const folder = integrated && body.trunkedScan && trunkedScanner?.mapDirectory
      ? trunkedScanner.mapDirectory : path.join(DATA_DIR, integrated ? 'digital' : 'dsd-fme');
    const { channelMap, groupMap } = writeTrunkedDecoderMaps(trunked, selectedSite, freq, folder);
    args.push('-T', '-C', channelMap, '-G', groupMap);
    if (trunked.talkgroupFilterEnabled) args.push('-W');
  } else if (plan) {
    const digitalMemories = plan.channels;
    const folder = path.join(DATA_DIR, integrated ? 'digital' : 'dsd-fme'); fs.mkdirSync(folder, { recursive: true });
    const dsdScan = plan.engine === 'dsd';
    const channelMap = path.join(folder, dsdScan ? 'conventional-dsd-neo-scan.csv' : 'conventional-digital-scan.csv');
    scanningCount = digitalMemories.length;
    const modeFor = channel => ({ AM:'am', NFM:'nfm', WFM:'wfm', P25:'p25', DMR:'dmr', NXDN:channel.nxdnMode === 'NXDN96' ? 'nxdn96' : 'nxdn48', 'D-STAR':'dstar', YSF:'ysf', M17:'m17' })[channel.mode];
    const optionsFor = channel => channel.mode === 'NFM' ? '--nfm-bandwidth-hz 12500 --squelch noise+6'
      : channel.mode === 'AM' ? '--am-bandwidth-hz 10000 --squelch auto+6'
      : channel.mode === 'WFM' ? `--wfm-bandwidth-hz 180000 --squelch auto+6` : '';
    const rows = dsdScan
      ? ['channel,frequency_hz,name,mode,options', ...digitalMemories.map((channel,index) => `${index + 1},${channel.frequency},${String(channel.name).replace(/[\r\n,]+/g, ' ').slice(0, 60)},${modeFor(channel)},${optionsFor(channel)}`)]
      : ['ChannelNumber(dec),frequency(Hz) (do not delete this line or it will not import properly)', ...digitalMemories.map((channel,index) => `${index + 1},${channel.frequency},${String(channel.name).replace(/[\r\n,]+/g, ' ')}`)];
    fs.writeFileSync(channelMap, rows.join('\r\n') + '\r\n', 'utf8');
    args.push('-Y', '-t', dsdScan ? (plan.dwellMs / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : plan.rapid ? '0' : '1', '-C', channelMap);
  }
  await stopHd();
  if (receiver) await stopReceiver({ keepScan: body.hybridScan === true });
  if (generation !== digitalGeneration) throw new Error('Decoder start cancelled.');
  if (!body.hybridScan) stopScan();
  if (integrated) {
    if (digitalSession) await digitalSession.stop();
    const mono = flags.some(flag => ['-f1', '-fi', '-fn', '-fd', '-fy', '-fz'].includes(flag));
    const decoderChannels = mono ? 1 : 2;
    const firstAnalog = plan?.engine === 'dsd' && ['AM', 'NFM', 'WFM'].includes(plan.channels[0]?.mode);
    const inputAudioChannels = firstAnalog ? 1 : decoderChannels;
    const inputAudioRateHz = firstAnalog ? 48000 : 8000;
    activeDigitalConfig = { mode: protocol, ...digitalOptions(config) };
    const session = new DigitalDecoder({ args, channels: inputAudioChannels, inputRateHz: inputAudioRateHz, dataDir: path.join(DATA_DIR, 'digital'), protocol: decoderLabel, config: activeDigitalConfig, frequency: freq });
    digitalSession = session; digitalHistory = []; lastDigitalBroadcast = 0;
    activeFrequency = freq; appMode = protocol; selectedChannelId = trunked?.id || memory?.id || null;
    session.on('audio', ({ samples, level }) => {
      if (digitalSession !== session) return;
      const frame = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
      for (const client of clients) sendBinary(client, frame);
      broadcast({ type: 'meter', level, sampleRate: 48000 });
    });
    session.on('log', message => { if (digitalSession === session) broadcast({ type: 'digital-log', message }); });
    session.on('spectrum', frame => { if (digitalSession === session && session.active) broadcastSpectrum(frame); });
    session.on('tuned', frequency => { if (digitalSession === session) activeFrequency=frequency; });
    session.on('event', event => {
      if (digitalSession !== session) return;
      const index = digitalHistory.findIndex(row => row.key === event.key);
      if (index >= 0) digitalHistory[index] = event; else digitalHistory.push(event);
      digitalHistory = digitalHistory.slice(-100);
      broadcast({ type: 'digital-event', event });
    });
    session.on('state', state => {
      if (digitalSession !== session) return;
      const frequency = Number(state.frequency || state.system?.center_freq_hz || state.decoderStatus?.center_freq_hz);
      if (frequency >= 10000) activeFrequency = frequency;
      if (state.metrics?.tuner_gain_is_auto === true) activeGain = 0;
      else if (Number.isFinite(state.metrics?.tuner_gain_tenth_db)) activeGain = state.metrics.tuner_gain_tenth_db;
      if (digitalScan) {
        const scanRow = state.decoderStatus?.scan_row;
        const targetId = Number(scanRow?.target_id), rowNumber = Number(scanRow?.row);
        const byRow = plan?.engine === 'dsd' && Number.isInteger(rowNumber) ? plan.channels[rowNumber] || null : null;
        const byTarget = plan?.engine === 'dsd' ? plan.channels.find((channel,index) => targetId === index + 1) : null;
        const byLabel = plan?.engine === 'dsd' && scanRow?.label ? plan.channels.find(channel => channel.name === scanRow.label) : null;
        const byFrequency = plan?.channels.find(item => item.frequency === activeFrequency) || null;
        const channel = byRow || byTarget || byLabel || byFrequency || null;
        if (channel) {
          if (plan?.engine === 'dsd') {
            const analogAudio = ['AM', 'NFM', 'WFM'].includes(channel.mode);
            session.setAudioFormat(analogAudio ? 1 : decoderChannels, analogAudio ? 48000 : 8000);
          }
          if (digitalScan.channel?.id !== channel.id) digitalScan.hops = (digitalScan.hops || 0) + 1;
          digitalScan.channel = channel;
          activeFrequency = channel.frequency; appMode = channel.mode; selectedChannelId = channel.id;
        }
        digitalScan.holding = state.calls.some(call => call.state === 2);
      }
      if (scanner?.active && scanner.plan.engine === 'hybrid' && DIGITAL_MODES.has(scanner.current?.mode)) {
        scanner.observeActivity(state.calls.some(call => call.state === 2));
      }
      if (trunkedScanner?.active && trunkedScanner.current) {
        const scan = trunkedScanner, callActive = state.calls.some(call => call.state === 2);
        scan.callActive = callActive;
        if (scan.paused) {
          if (scan.holdOnSignal && callActive) scan.holding = true;
          if (scan.timer) clearTimeout(scan.timer);
          if (scan.resumeTimer) clearTimeout(scan.resumeTimer);
          scan.timer = null; scan.resumeTimer = null;
          scan.activity = scan.holding ? callActive ? 'Paused during voice call' : 'Paused after voice call' : 'Paused on current control channel';
        } else if (!scan.holdOnSignal) {
          scan.holding = false;
          scan.activity = callActive ? 'Voice call active · scan continues' : state.decoderStatus?.trunking ? 'Control channel locked' : 'Monitoring control channel';
        } else if (callActive) {
          if (scan.timer) clearTimeout(scan.timer);
          if (scan.resumeTimer) clearTimeout(scan.resumeTimer);
          scan.timer = null; scan.resumeTimer = null; scan.holding = true; scan.activity = 'Voice call active';
        } else if (scan.holding) {
          scan.activity = 'Call ended · waiting to resume';
          if (!scan.resumeTimer) scan.resumeTimer = setTimeout(() => {
            if (trunkedScanner !== scan || !scan.active || scan.paused) return;
            scan.holding = false; scan.resumeTimer = null; void advanceTrunkedScan(scan);
          }, scan.holdMs);
        } else scan.activity = state.decoderStatus?.trunking ? 'Control channel locked' : 'Monitoring control channel';
      }
      if (Date.now() - lastDigitalBroadcast >= 240 || state.phase !== 'listening') {
        lastDigitalBroadcast = Date.now();
        broadcast({ type: 'digital-state', digital: state, frequency: activeFrequency, gain: activeGain,
          scan: scanner?.active ? scanner.snapshot() : trunkedScanner?.active ? trunkedScanSnapshot(trunkedScanner) : digitalScan });
      }
    });
    session.on('failure', error => {
      if (digitalSession !== session) return;
      digitalScan = null;
      if (trunkedScanner?.active) { void stopTrunkedScan({ error: error.message, stopDecoder: false }); return; }
      broadcast({ type: 'digital-error', message: error.message });
      broadcast({ type: 'status', status: status() });
    });
    session.on('stopped', () => { if (digitalSession === session) { digitalScan = null; broadcast({ type: 'status', status: status() }); } });
    try {
      await session.start();
      if (generation !== digitalGeneration) { await session.stop(); throw new Error('Decoder start cancelled.'); }
      if (plan) digitalScan = { active: true, engine: plan.engine, rapid: plan.rapid, dwellMs: plan.engine === 'dsd' ? plan.dwellMs : plan.rapid ? 0 : 1000, channelIds: plan.channelIds, channelCount: plan.channels.length, holding: false, paused: false, channel: plan.channels[0], hops: 0 };
      broadcast({ type: 'status', status: status() });
      return { active: true, engine: 'integrated', protocol, protocolLabel: decoderLabel, frequency: activeFrequency,
        channel: trunked?.name || null, site: selectedSite?.name || null, scanning: scanningCount || null, scan: digitalScan, digital: session.snapshot() };
    } catch (error) {
      digitalScan = null; lastDigitalState = session.snapshot();
      if (digitalSession === session) digitalSession = null;
      throw new Error(`Integrated decoder: ${error.message}`);
    }
  }
  try {
    activeDigitalConfig = { mode: protocol, ...digitalOptions(config) };
    const env = { ...process.env };
    if (process.platform === 'linux') {
      try {
        const libraryPath = rtlLibraryPath(settings.rtlLibraryPath);
        if (path.isAbsolute(libraryPath)) env.LD_LIBRARY_PATH = [path.dirname(libraryPath), env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
      } catch {}
    }
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    digitalProcess = child;
    child.stdin?.on('error', () => {});
    setSettings({ dsdPath: binary });
    child.stdout?.on('data', data => broadcast({ type: 'digital-log', message: data.toString().slice(-1500) }));
    child.stderr?.on('data', data => broadcast({ type: 'digital-log', message: data.toString().slice(-1500) }));
    child.once('error', err => { if (digitalProcess === child) digitalProcess = null; broadcast({ type: 'digital-log', message: `Could not start DSD-FME: ${err.message}` }); broadcast({ type: 'status', status: status() }); });
    child.once('exit', code => { if (digitalProcess === child) { digitalProcess = null; digitalScan = null; } broadcast({ type: 'status', status: status(), message: `DSD-FME exited (${code ?? 'unknown'}).` }); });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } catch (err) { throw new Error(`Could not start DSD-FME: ${err.message}`); }
  activeFrequency = freq; appMode = MODES.has(protocol) ? protocol : 'P25'; selectedChannelId = trunked?.id || null;
  if (plan) digitalScan = { active: true, engine: plan.engine, rapid: plan.rapid, dwellMs: plan.engine === 'dsd' ? plan.dwellMs : plan.rapid ? 0 : 1000, channelIds: plan.channelIds, channelCount: plan.channels.length, holding: false, paused: false, channel: null, hops: 0 };
  broadcast({ type: 'status', status: status() });
  return { active: true, protocol, protocolLabel: protocolLabel(config), frequency: freq, channel: trunked?.name || null, site: selectedSite?.name || null, scanning: scanningCount || null, scan: digitalScan, note: 'DSD-FME owns the dongle while this decoder is running.' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': `http://127.0.0.1:${PORT}`, 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' }); res.end(); return; }
  if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${PORT}`) return sendJson(res, 403, { error: 'Open Signal Outpost from its local desktop window.' });
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, { status: status(), channels, settings, digitalRuntime: digitalRuntime(), digitalHistory, hdRuntime: hdRuntime() });
    if (url.pathname === '/api/propagation/preferences' && req.method === 'GET') return sendJson(res, 200, propagation.preferences());
    if (url.pathname === '/api/propagation/preferences' && req.method === 'POST') return sendJson(res, 200, propagation.savePreferences(await parseBody(req, 4096)));
    if (url.pathname === '/api/propagation/weather' && req.method === 'GET') return sendJson(res, 200, await propagation.weather());
    if (url.pathname === '/api/propagation/iss' && req.method === 'GET') return sendJson(res, 200, await propagation.iss(url.searchParams.get('passes') === '1'));
    if (url.pathname === '/api/propagation/geocode' && req.method === 'POST') return sendJson(res, 200, await propagation.geocode(await parseBody(req, 4096)));
    if (url.pathname === '/api/propagation/activity' && req.method === 'GET') return sendJson(res, 200, await propagation.activity());
    if (url.pathname === '/api/meshcore/state' && req.method === 'GET') return sendJson(res, 200, meshcore.snapshot());
    if (url.pathname === '/api/meshcore/devices' && req.method === 'GET') return sendJson(res, 200, meshcoreCatalog);
    if (url.pathname === '/api/meshcore/ports' && req.method === 'GET') return sendJson(res, 200, { ports: await meshcore.ports() });
    if (url.pathname === '/api/meshcore/connect' && req.method === 'POST') return sendJson(res, 200, meshcore.connect(await parseBody(req, 4096)));
    if (url.pathname === '/api/meshcore/disconnect' && req.method === 'POST') {
      const body = await parseBody(req, 4096);
      if (body.session && body.session !== meshcore.connectionId) return sendJson(res, 200, { disconnected: true });
      return sendJson(res, 200, meshcore.disconnect());
    }
    if (url.pathname === '/api/meshcore/refresh' && req.method === 'POST') return sendJson(res, 200, await meshcore.refresh());
    if (url.pathname === '/api/meshcore/advertise' && req.method === 'POST') return sendJson(res, 200, await meshcore.advertise(await parseBody(req, 4096)));
    if (url.pathname === '/api/meshcore/send' && req.method === 'POST') return sendJson(res, 200, await meshcore.send(await parseBody(req, 4096)));
    if (url.pathname === '/api/meshcore/read' && req.method === 'POST') return sendJson(res, 200, meshcore.markRead(await parseBody(req, 128000)));
    if (url.pathname === '/api/meshcore/organize' && req.method === 'POST') return sendJson(res, 200, meshcore.organize(await parseBody(req, 4096)));
    if (url.pathname === '/api/meshcore/repeater' && req.method === 'POST') return sendJson(res, 200, await meshcore.repeaterAction(await parseBody(req, 4096)));
    if (url.pathname === '/api/meshcore/ble/start' && req.method === 'POST') { const body = await parseBody(req, 4096); return sendJson(res, 200, meshcore.startBle(body.session)); }
    if (url.pathname === '/api/meshcore/ble/rx' && req.method === 'POST') { const body = await parseBody(req, 4096); meshcore.receiveBle(body.session, body.frame); return sendJson(res, 200, { received: true }); }
    if (url.pathname === '/api/meshcore/ble/heartbeat' && req.method === 'POST') { const body = await parseBody(req, 4096); meshcore.checkBle(body.session); return sendJson(res, 200, { active: true }); }
    if (url.pathname === '/api/meshcore/ble/failed' && req.method === 'POST') { const body = await parseBody(req, 4096); meshcore.checkBle(body.session); meshcore.fail(new Error(String(body.error || 'Bluetooth connection lost.'))); return sendJson(res, 200, { disconnected: true }); }
    if (url.pathname === '/api/hd/start' && req.method === 'POST') return sendJson(res, 200, await startHd(await parseBody(req)));
    if (url.pathname === '/api/hd/stop' && req.method === 'POST') { await stopHd(); return sendJson(res, 200, status()); }
    if (url.pathname === '/api/hd/fallback' && req.method === 'POST') {
      const body = await parseBody(req);
      if (typeof body.enabled !== 'boolean') throw new Error('Choose whether automatic FM fallback is enabled.');
      if (hdStarting) throw new Error('Wait for HD Radio to finish starting.');
      setSettings({ hdFmFallback: body.enabled });
      if (hdSession?.active) await hdSession.setFallback(body.enabled);
      broadcast({ type: 'status', status: status() }); return sendJson(res, 200, status());
    }
    if (url.pathname === '/api/hd/program' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!hdSession?.active || hdStarting) throw new Error('Start HD Radio before selecting a program.');
      hdSession.selectProgram(body.program); return sendJson(res, 200, status());
    }
    if (url.pathname.startsWith('/api/hd/art/') && req.method === 'GET') {
      const parts = url.pathname.split('/'); const image = parts.length === 6 && parts[4] === hdSession?.sessionId ? hdSession.images.get(parts[5]) : null;
      if (!image) { res.writeHead(404); res.end('Artwork unavailable'); return; }
      res.writeHead(200, { 'content-type': image.mime, 'content-length': image.bytes.length, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }); res.end(image.bytes); return;
    }
    if (url.pathname === '/api/rtl/devices' && req.method === 'GET') return sendJson(res, 200, await listUsbDevices(settings.rtlLibraryPath));
    if (url.pathname === '/api/rtl/start' && req.method === 'POST') return sendJson(res, 200, await startReceiver(await parseBody(req)));
    if (url.pathname === '/api/rtl/stop' && req.method === 'POST') { stopScan(); await stopReceiver(); return sendJson(res, 200, status()); }
    if (url.pathname === '/api/tune' && req.method === 'POST') { const b = await parseBody(req); if (scanner?.active) stopScan(); await tune(b.frequency); return sendJson(res, 200, status()); }
    if (url.pathname === '/api/mode' && req.method === 'POST') {
      const b = await parseBody(req); if (!MODES.has(b.mode)) throw new Error('Unsupported demodulation mode.');
      if (digitalProcess || digitalSession?.active || digitalStarting) throw new Error('Stop the digital decoder before changing its protocol.');
      if (hdStarting) throw new Error('Wait for HD Radio to finish starting.');
      if (b.mode === 'HD' && receiver?.connected) return sendJson(res, 200, await startHd({ frequency: activeFrequency, program: b.program || 0 }));
      if (hdSession?.active && b.mode !== 'HD') {
        if (DIGITAL_MODES.has(b.mode)) throw new Error('Stop HD Radio before starting a digital voice decoder.');
        await stopHd(); return sendJson(res, 200, await startReceiver({ frequency: activeFrequency, mode: b.mode, gain: settings.tunerGain }));
      }
      if (scanner?.active) stopScan(); appMode = b.mode; resetDsp(); broadcast({ type: 'status', status: status() }); return sendJson(res, 200, status());
    }
    if (url.pathname === '/api/gain' && req.method === 'POST') {
      const b = await parseBody(req); const gain = Math.max(0, Math.min(500, Math.round(Number(b.gain) || 0)));
      if (digitalSession?.active) { await digitalSession.request('rtl_set_gain', { value: Math.min(49, Math.round(gain / 10)) }); activeGain = Math.min(49, Math.round(gain / 10)) * 10; }
      else if (hdSession?.active && hdSession.usb?.connected) activeGain = await hdSession.gain(gain);
      else activeGain = receiver?.connected ? await receiver.command('gain', gain) : gain;
      return sendJson(res, 200, status());
    }
    if (url.pathname === '/api/channels' && req.method === 'GET') return sendJson(res, 200, channels);
    if (url.pathname === '/api/channels' && req.method === 'POST') {
      const b = await parseBody(req); const channel = normalizeChannel(b);
      channels.unshift(channel); writeJson(CHANNELS_FILE, channels); return sendJson(res, 201, channel);
    }
    if (url.pathname.startsWith('/api/channels/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/channels/'.length)); channels = channels.filter(c => c.id !== id); writeJson(CHANNELS_FILE, channels); return sendJson(res, 200, { deleted: true });
    }
    if (url.pathname.startsWith('/api/channels/') && req.method === 'PUT') {
      const id = decodeURIComponent(url.pathname.slice('/api/channels/'.length)); const b = await parseBody(req);
      const index = channels.findIndex(c => c.id === id); if (index < 0) throw new Error('Memory channel not found.');
      channels[index] = { ...channels[index], ...normalizeChannel({ ...channels[index], ...b, id }, false) }; writeJson(CHANNELS_FILE, channels); return sendJson(res, 200, channels[index]);
    }
    if (url.pathname === '/api/scan/start' && req.method === 'POST') return sendJson(res, 200, await startScan(await parseBody(req)));
    if (url.pathname === '/api/scan/pause' && req.method === 'POST') {
      const body = await parseBody(req);
      if (typeof body.paused !== 'boolean') throw new Error('Choose whether to pause or resume scanning.');
      if (scanner?.active) {
        if (body.paused) scanner.pause(); else await scanner.resume();
      } else if (trunkedScanner?.active) {
        setTrunkedScanPaused(trunkedScanner, body.paused);
      } else if (digitalScan?.active) {
        if (!digitalSession?.active) throw new Error('Pause and resume require the integrated DSD-neo decoder.');
        if (Boolean(digitalScan.paused) !== body.paused) await digitalSession.request('scan_hold_toggle');
        digitalScan.paused = body.paused;
        broadcast({ type: 'status', status: status() });
      } else throw new Error('Start a memory scan before pausing it.');
      return sendJson(res, 200, status());
    }
    if (url.pathname === '/api/scan/stop' && req.method === 'POST') {
      const body = await parseBody(req);
      const scan = scanner?.active ? scanner.snapshot() : null;
      stopScan();
      if (scan?.engine === 'hybrid') {
        if (digitalProcess || digitalSession?.active) await stopDigital();
        else if (receiver && body.keepReceiver !== true) await stopReceiver();
      } else if (trunkedScanner) await stopTrunkedScan();
      else if (digitalScan) await stopDigital();
      else if (receiver && body.keepReceiver !== true) await stopReceiver();
      return sendJson(res, 200, status());
    }
    if (url.pathname === '/api/scan/skip' && req.method === 'POST') {
      if (trunkedScanner?.active) await advanceTrunkedScan(trunkedScanner, true);
      else if (digitalScan && digitalSession?.active) await digitalSession.request('channel_cycle');
      else { if (!scanner?.active) throw new Error('Start a memory scan before skipping.'); await scanner.skip(); }
      return sendJson(res, 200, status());
    }
    if (url.pathname === '/api/kiwi/receivers' && req.method === 'GET') return sendJson(res, 200, await kiwiDirectory.list(url.searchParams.get('refresh') === '1'));
    if (url.pathname === '/api/kiwi/connect' && req.method === 'POST') {
      const b = await parseBody(req), station = await kiwiDirectory.check(String(b.id));
      if (station.reachable && !station.connectable) return sendJson(res, 409, { error: station.online ? 'This receiver is full. Choose another station with a free slot.' : 'This receiver is currently offline. Choose another station.', receiver: station });
      setSettings({ kiwiUrl: station.url, kiwiReceiverId: station.id });
      return sendJson(res, 200, station);
    }
    if (url.pathname === '/api/kiwi/favorites' && req.method === 'POST') { const b = await parseBody(req); if (!Array.isArray(b.ids)) throw new Error('Invalid favorites list.'); setSettings({ kiwiFavorites: [...new Set(b.ids.filter(id => typeof id === 'string' && /^[a-f0-9]{20}$/.test(id)))].slice(0, 100) }); return sendJson(res, 200, { ids: settings.kiwiFavorites }); }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await parseBody(req);
      const integer = (name, min, max) => { const n = Number(b[name] ?? settings[name]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name} setting.`); return n; };
      setSettings({ rtlLibraryPath: String(b.rtlLibraryPath ?? settings.rtlLibraryPath).trim(),
        deviceIndex: integer('deviceIndex', 0, 63), deviceSerial: String(b.deviceSerial ?? settings.deviceSerial).slice(0, 256),
        ppm: integer('ppm', -250, 250), tunerGain: integer('tunerGain', 0, 500), directSampling: integer('directSampling', 0, 2), tunerBandwidth: integer('tunerBandwidth', 0, 3200000),
        rtlAgc: Boolean(b.rtlAgc ?? settings.rtlAgc), biasTee: Boolean(b.biasTee ?? settings.biasTee),
        digitalEngine: (b.digitalEngine ?? settings.digitalEngine) === 'external' ? 'external' : 'integrated',
        dsdPath: String(b.dsdPath ?? settings.dsdPath).trim(), sampleRate: integer('sampleRate', 1024000, 3200000), wsjtPort: integer('wsjtPort', 1024, 65535),
        audioOutputId: String(b.audioOutputId ?? settings.audioOutputId ?? '').slice(0, 512) });
      return sendJson(res, 200, settings);
    }
    if (url.pathname === '/api/wsjt/start' && req.method === 'POST') { const b = await parseBody(req); return sendJson(res, 200, await startWsjtBridge(b.port)); }
    if (url.pathname === '/api/wsjt/stop' && req.method === 'POST') { stopWsjtBridge(); return sendJson(res, 200, { active: false }); }
    if (url.pathname === '/api/radioreference/import' && req.method === 'POST') return sendJson(res, 201, await importRadioReference(await parseBody(req)));
    if (url.pathname === '/api/digital/start' && req.method === 'POST') return sendJson(res, 200, await startDigital(await parseBody(req)));
    if (url.pathname === '/api/digital/stop' && req.method === 'POST') { await stopDigital(); return sendJson(res, 200, status()); }
    if (url.pathname === '/api/digital/control' && req.method === 'POST') {
      if (!digitalSession?.active || digitalSession.phase !== 'listening') throw new Error('Start the integrated decoder first.');
      const b = await parseBody(req);
      if (b.action === 'return-control') {
        if (!digitalSession.telemetry.status?.trunking) throw new Error('Select a trunked memory to return to its control channel.');
        await digitalSession.request('return_cc');
      } else if (b.action === 'slot') {
        const value = Number(b.value); if (![0, 1, 2].includes(value)) throw new Error('Choose slot 1, slot 2, or automatic.');
        await digitalSession.request('slot_pref_set', { value });
      } else throw new Error('Unsupported decoder control.');
      return sendJson(res, 200, status());
    }
    if (url.pathname === '/api/shutdown' && req.method === 'POST') { meshcore.disconnect(); stopScan(); await stopHd(); await stopReceiver(); await stopDigital(); stopWsjtBridge(); sendJson(res, 200, { stopped: true }); setTimeout(() => { for (const client of clients) client.destroy(); server.close(); }, 100); return; }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const publicFiles = new Set(['index.html', 'app.js', 'app.css', 'theme.js', 'theme.css', 'theme-light.css', 'meshcore-ui.js', 'meshcore.css', 'kiwi-network.js', 'hd-radio-ui.js', 'propagation-ui.js', 'propagation.css', 'lib/propagation-bands.mjs', 'lib/meshcore-devices.mjs', 'lib/meshcore-conversations.mjs', 'lib/meshcore-paths.mjs', 'lib/channel-protocols.mjs', 'lib/current-memory.mjs', 'lib/hd-options.mjs', 'lib/playback-buffer.mjs', 'lib/waterfall-tuning.mjs', 'assets/app-icon.svg', 'assets/app-icon.png']);
    const leafletFiles = new Set(['leaflet.js', 'leaflet.css', 'images/layers.png', 'images/layers-2x.png', 'images/marker-icon.png', 'images/marker-icon-2x.png', 'images/marker-shadow.png']);
    const vendorName = relative.startsWith('vendor/leaflet/') ? relative.slice('vendor/leaflet/'.length) : '';
    if (!publicFiles.has(relative) && !leafletFiles.has(vendorName)) { res.writeHead(404); res.end('Not found'); return; }
    const file = vendorName ? path.join(ROOT, 'node_modules', 'leaflet', 'dist', vendorName) : path.resolve(ROOT, relative);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' ws://127.0.0.1:${PORT}; frame-src http: https:; object-src 'none'; base-uri 'self'; form-action 'self'` });
    fs.createReadStream(file).pipe(res);
  } catch (err) { sendJson(res, 400, { error: err.message || 'Request failed.' }); }
});

function normalizeChannel(value, createId = true) { return normalizeMemory(value, createId); }

server.on('upgrade', (req, socket) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.url !== '/stream' || req.headers.origin !== `http://127.0.0.1:${PORT}`) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key']; if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket); socket.write(makeWsFrame(Buffer.from(JSON.stringify({ type: 'status', status: status() })), 1));
  socket.on('data', data => { // Handle close and ping control frames from the browser.
    if ((data[0] & 0x0f) === 8) { clients.delete(socket); socket.end(); }
    else if ((data[0] & 0x0f) === 9) socket.write(makeWsFrame(data.subarray(2), 10));
  });
  socket.on('close', () => clients.delete(socket)); socket.on('error', () => clients.delete(socket));
});

server.listen(PORT, '127.0.0.1', () => console.log(`Signal Outpost is ready at http://127.0.0.1:${PORT}`));
async function shutdown() { meshcore.disconnect(); stopScan(); await stopHd(); await stopReceiver(); await stopDigital(); stopWsjtBridge(); for (const client of clients) client.destroy(); server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
