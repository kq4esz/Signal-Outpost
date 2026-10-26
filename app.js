import { KiwiNetwork } from './kiwi-network.js';
import { digitalOptions, protocolLabel, protocolChoice, siteFrequencies } from './lib/channel-protocols.mjs';
import { currentMemoryDraft } from './lib/current-memory.mjs';
import { HdRadioUi } from './hd-radio-ui.js';
import { hdMemoryOptions } from './lib/hd-options.mjs';
import { PlaybackBuffer } from './lib/playback-buffer.mjs';
import { MeshCoreUi } from './meshcore-ui.js';
import { PropagationUi } from './propagation-ui.js';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const DIGITAL = new Set(['P25', 'DMR', 'NXDN', 'D-STAR', 'YSF', 'M17']);
const MODE_HINTS = { AM:'Amplitude modulation · airband & broadcast', NFM:'Narrow FM · voice', WFM:'Wide FM · broadcast', USB:'Upper sideband · HF voice', LSB:'Lower sideband · HF voice', CW:'Morse code · built-in decoder', RAW:'Raw IQ audio · monitor only', P25:'P25 voice · integrated decoder', DMR:'DMR voice · integrated decoder', NXDN:'NXDN voice · integrated decoder', 'D-STAR':'D-STAR voice · integrated decoder', YSF:'System Fusion · integrated decoder', M17:'M17 voice · integrated decoder' };
const MODE_LABELS = { NFM:'Narrow FM', WFM:'Wide FM', AM:'AM', USB:'Upper sideband', LSB:'Lower sideband', CW:'CW', RAW:'RAW IQ', P25:'P25', DMR:'DMR', NXDN:'NXDN', 'D-STAR':'D-STAR', YSF:'YSF', M17:'M17' };
const state = { status:null, channels:[], settings:{}, usbDevices:[], platform:'unknown', network:null, page:'radio', spectrum:null, sampleRate:48000, currentStep:25000, audio:null, socket:null, volume:.72, muted:false, scanning:false, ft8:false, cwText:'', activity:[], spectrumRaf:0, waterfallRows:0, selectedTrunkId:'', lastError:'' };
MODE_HINTS.HD = 'HD Radio · digital FM / AM broadcast'; MODE_LABELS.HD = 'HD Radio';
state.scanSelection = new Set(); state.scan = null; state.editingChannel = null; state.decoderMemoryId = '';
state.digitalEvents = []; state.digitalLogs = []; state.digitalBusy = false;
state.rfHistory = []; state.spectrumEpoch = ''; state.spectrumPaused = false; state.lastLiveSpectrum = null; state.wideSurvey = null; state.spectrumGeneration = 0;
let audioQueue = new PlaybackBuffer(), scriptNode = null, audioContext = null, audioGain = null, silentSource = null;
const spectrumViews = ['radio','decoders'].map(page => {
  const prefix=page==='radio'?'':'decoder-';
  const canvas=$(`#${prefix}spectrum-canvas`),waterfall=$(`#${prefix}waterfall-canvas`);
  return {page,prefix,canvas,context:canvas.getContext('2d'),waterfall,waterfallContext:waterfall.getContext('2d'),lastFrame:0,epoch:'',zoom:1};
});

async function api(path, body) {
  const response = await fetch(path, body === undefined ? { cache:'no-store' } : { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Server returned HTTP ${response.status}.`); }
  if (!response.ok) { const error = new Error(result.error || `Request failed (${response.status}).`); error.details = result; throw error; }
  return result;
}
function toast(message, kind='') {
  const item = document.createElement('div'); item.className = `toast ${kind}`; item.textContent = message;
  $('#toast-region').append(item); setTimeout(() => item.remove(), 3600);
}
function updateClock() {
  const now = new Date();
  $('#local-time').textContent = new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
  $('#utc-time').textContent = `UTC ${new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',hour12:false}).format(now)}`;
}
function formatMHz(hz, places=6) { return (Number(hz || 0) / 1e6).toFixed(places); }
function formatFrequency(hz) {
  const f = Number(hz || 0);
  if (f >= 1e9) return `${(f / 1e9).toFixed(6)} GHz`;
  if (f >= 1e6) return `${(f / 1e6).toFixed(6)} MHz`;
  return `${(f / 1e3).toFixed(3)} kHz`;
}
function isConnected() { return Boolean(state.status?.connected); }
function isHdActive() { return Boolean(state.status?.hdActive); }
function isDigitalActive() { return Boolean(state.status?.digitalActive); }
function setPage(name) {
  if (!$('#page-' + name)) return;
  state.page = name;
  window.scrollTo({ top: 0, behavior: 'instant' });
  $$('.page').forEach(page => page.classList.toggle('active', page.id === `page-${name}`));
  $$('.nav-item[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === name));
  const labels = { radio:'Live radio', channels:'Memory channels', remote:'KiwiSDR network', decoders:'Decoders', propagation:'Propagation', meshcore:'MeshCore', settings:'Settings' };
  $('#page-title').textContent = labels[name] || 'Live radio';
  if (name === 'meshcore') void state.meshcore?.show();
  if (name === 'propagation') void state.propagation?.show();
  if (name === 'radio' || name === 'decoders') {drawSpectrum();drawWaterfall(true);renderSpectrumStatus();}
  if (name === 'remote') state.network?.show();
  if (name === 'settings' && !state.usbDevices.length) refreshUsbDevices();
}
function setFrequencyDisplay(freq) { $('#frequency-input').value = formatMHz(freq);if(document.activeElement!==$('#digital-frequency-input'))$('#digital-frequency-input').value=formatMHz(freq);state.hdUi?.render(); }
function modeHint(mode) { $('#mode-hint').textContent = MODE_HINTS[mode] || 'Analog demodulation'; }
function renderStatus() {
  const status = state.status || {};
  $('#desktop-version').textContent = status.appVersion ? `DESKTOP ${status.appVersion}` : 'DESKTOP';
  state.propagation?.updateStatus(status);
  state.ft8=Boolean(status.wsjtActive);$('#ft8-dot').classList.toggle('active',state.ft8);$('#ft8-state').textContent=state.ft8?'Listening for WSJT-X':'Bridge not started';$('#ft8-toggle').textContent=state.ft8?'Stop bridge':'Start bridge';$('#ft8-port').textContent=`UDP 127.0.0.1:${status.wsjtPort||state.settings.wsjtPort||2237}`;
  const receiverState = $('#receiver-state');
  const connected = Boolean(status.connected), digital = Boolean(status.digitalActive), hd = Boolean(status.hdActive);
  const integrated = digital && status.digital?.engine === 'integrated';
  if (!connected && !integrated && !hd) { $('#audio-state').textContent = digital ? 'External decoder audio' : 'Audio stopped'; $('#audio-meter').style.width = '0%'; }
  receiverState.classList.toggle('connected', connected || digital || hd);
  $('#receiver-state-label').textContent = hd ? status.hd?.audioSource==='fm'?'FM fallback active':'HD Radio active' : digital ? 'Digital decoder active' : connected ? 'Receiver connected' : 'Receiver offline';
  $('#receiver-rate').textContent = hd ? 'HD Radio · USB' : digital ? `${integrated ? 'DSD-neo' : 'DSD-FME'} · USB` : connected ? `USB · ${(status.sampleRate || 2400000) / 1e6} MSPS` : 'Direct USB';
  $('#sidebar-device').classList.toggle('connected', connected || digital || hd);
  $('#sidebar-device-state').textContent = hd ? 'HD Radio · USB' : digital ? 'Digital decoding · USB' : connected ? `${status.rtlInfo?.product || 'RTL-SDR'} · USB` : 'USB · Not connected';
  $('#connect-button').classList.toggle('connected', connected || digital || hd);
  $('#connect-button .listen-label').textContent = hd ? 'Stop HD Radio' : digital ? 'Stop decoder' : connected ? 'Stop listening' : $('#mode-select').value === 'HD' ? 'Listen in HD' : DIGITAL.has($('#mode-select').value) ? 'Start decoder' : 'Start listening';
  $('#connect-button .listen-symbol').textContent = connected || digital || hd ? '■' : '▶';
  renderSpectrumStatus();
  $('#source-label').textContent = hd ? status.hd?.audioSource==='fm'?`FM main program · HD${(status.hd?.program || 0) + 1} recovery active · USB`:`HD Radio · HD${(status.hd?.program || 0) + 1} · USB` : digital ? `Digital voice · ${integrated ? 'DSD-neo' : 'DSD-FME'} · USB` : connected ? `USB · ${status.rtlInfo?.product || 'RTL-SDR'} · ${status.rtlInfo?.tunerName || ''}` : 'Local USB receiver · RTL-SDR';
  $('.tune-source').classList.toggle('connected', connected || digital || hd);
  $('#gain-label').textContent = hd ? `HD ${status.hd?.gainMode==='auto'?'AUTO':'GAIN'} · ${Number((status.gain || 0) / 10).toFixed(1)} dB` : status.gain ? `GAIN ${Number(status.gain / 10).toFixed(1)} dB` : 'GAIN AUTO';
  $('#sample-rate-label').textContent = hd ? '1.488375 MSPS · 48 kHz audio' : digital ? integrated ? '48 kHz DSP · 8 kHz voice' : 'DIGITAL USB' : `${((status.sampleRate || state.settings.sampleRate || 2400000) / 1e6).toFixed(1)} MSPS`;
  const span = (status.sampleRate || 2400000) / 1e6;
  const center = Number(status.frequency || 100000000) / 1e6;
  if(!state.spectrum){$('#freq-left').textContent = (center - span / 2).toFixed(3);$('#freq-mid').textContent = `${center.toFixed(3)} MHz`;$('#freq-right').textContent = (center + span / 2).toFixed(3);}
  if (status.frequency && document.activeElement !== $('#frequency-input')) setFrequencyDisplay(status.frequency);
  if (status.mode && $('#mode-select').value !== status.mode) { $('#mode-select').value = status.mode; modeHint(status.mode); }
  if (status.scannerActive !== undefined) {
    state.scanning = status.scannerActive;
    state.scan = status.scan || null;
    $('#scan-button').innerHTML = state.scanning ? '<span>■</span> Stop scan' : '<span>⟳</span> Scan selected';
    $('#scan-button').classList.toggle('scanning', state.scanning);
  }
  const currentScan = status.scannerActive && status.scan?.active ? status.scan : null;
  const scanChannel = currentScan?.engine === 'trunked'
    ? [currentScan.current?.systemName, currentScan.current?.siteName].filter(Boolean).join(' · ') || currentScan.channel?.name
    : currentScan?.channel?.name;
  $('#scan-current-channel').classList.toggle('hidden', !scanChannel);
  $('#scan-current-channel-name').textContent = scanChannel || '';
  $('#scan-current-channel-name').title = scanChannel || '';
  renderScanStatus();
  renderDigital();
  $('#save-current-memory').disabled=Boolean(status.digitalStarting||state.digitalBusy||status.hdStarting);
  $('#digital-add-memory').disabled=Boolean(status.digitalStarting||state.digitalBusy||status.hdStarting);
  const audioIdentity = hd ? `hd:${status.hd?.sessionId}:${status.hd?.program}:${status.hd?.outputRevision || 0}` : `${connected || integrated}:${status.mode}:${status.frequency}`;
  if (state.audioIdentity !== audioIdentity) { audioQueue.clear();state.audioIdentity=audioIdentity; }
  if ((connected || integrated || hd) && !audioContext) setupAudio().catch(() => {});
  if (!connected && !integrated && !hd && audioContext) void stopAudio();
  state.hdUi?.render();
}

function renderDigital() {
  const digital = state.status?.digital, active = isDigitalActive(), trunkScan=Boolean(state.status?.scan?.active&&state.status.scan.engine==='trunked'), integrated = digital?.engine === 'integrated';
  const runtime = state.digitalRuntime || digital?.runtime;
  const external = active ? !integrated : state.settings.digitalEngine === 'external';
  if(!active&&state.selectedTrunkId){const channel=state.channels.find(item=>item.id===state.selectedTrunkId);const site=channel?.sites?.find(item=>String(item.id)===$('#digital-site').value)||channel?.sites?.[0];const frequency=site?.frequencies?.find(item=>item.use==='d')?.frequency||site?.frequencies?.[0]?.frequency||channel?.frequency;if(frequency)$('#digital-frequency-input').value=formatMHz(frequency);}
  $('#digital-engine-badge').textContent = external ? 'EXTERNAL ENGINE' : 'INTEGRATED · PREVIEW';
  $('#digital-toggle').textContent = trunkScan ? 'Control scan active' : state.digitalBusy ? 'Please wait…' : active ? 'Stop decoder' : 'Start decoder';
  $('#digital-toggle').disabled = trunkScan || state.digitalBusy || !active && !external && runtime?.available === false;
  $('#digital-add-memory').disabled=Boolean(state.digitalBusy||state.status?.digitalStarting);
  $('#save-current-memory').disabled=Boolean(state.digitalBusy||state.status?.digitalStarting);
  for (const id of ['digital-protocol', 'digital-system', 'digital-site', 'digital-scan']) $('#'+id).disabled = active || trunkScan || state.digitalBusy;
  $('#digital-site').disabled ||= !state.selectedTrunkId || !$('#digital-site').options.length;
  $('#digital-scan').disabled ||= Boolean(state.selectedTrunkId);
  $('#digital-frequency-input').disabled=active||trunkScan||state.digitalBusy||Boolean(state.selectedTrunkId)||$('#digital-scan').checked;
  $('#digital-slot').disabled = !integrated || digital.phase !== 'listening';
  $('#digital-return-cc').disabled = trunkScan || !integrated || !digital.decoderStatus?.trunking || digital.phase !== 'listening';
  const output = $('#digital-output'); output.classList.toggle('active', active);
  output.classList.toggle('failed', digital?.phase === 'failed');
  let label = 'Decoder idle · Choose a protocol or a saved trunked system.';
  if (digital?.phase === 'failed') label = digital.lastError || 'Decoder stopped after an error.';
  else if (state.digitalBusy || digital?.phase === 'starting') label = 'Opening the USB receiver and decoder…';
  else if (active) label = external ? 'External DSD-FME running · Audio is managed by that engine.' : `${digital.protocol || 'Digital voice'} · ${digital.decoderStatus?.protocol && digital.decoderStatus.protocol !== 'None' ? 'Receiving ' + digital.decoderStatus.protocol : 'Listening for valid frames'} · Audio in Signal Outpost`;
  output.querySelector('span').textContent = label;
  $('#digital-runtime-label').textContent = runtime ? `Bundled ${runtime.name} ${runtime.version} · ${runtime.codec}` : 'Bundled DSD-neo · IMBE / AMBE codec included';
  $('#digital-runtime-status').textContent = runtime?.available ? `${runtime.name} ${runtime.version} · Preview build · Ready` : 'Bundled digital decoder is unavailable in this package.';
  $('#digital-runtime-status').classList.toggle('unavailable', !runtime?.available);
  const metrics = active && integrated ? digital.metrics : null;
  const system = active && integrated ? digital.system : null;
  $('#digital-sync').textContent = active && integrated ? digital.decoderStatus?.protocol || digital.protocol : '—';
  $('#digital-frequency').textContent = active ? formatFrequency(state.status.frequency) : '—';
  $('#digital-snr').textContent = Number.isFinite(metrics?.snr_db) ? `${metrics.snr_db.toFixed(1)} dB` : '—';
  $('#digital-symbols').textContent = Number.isFinite(metrics?.symbol_rate_hz) ? `${metrics.symbol_rate_hz.toLocaleString()} symbols/s` : '—';
  $('#digital-control').textContent = system?.trunking && system.cc_freq_hz > 0 ? formatFrequency(system.cc_freq_hz) : '—';
  const fec = active && integrated ? digital.quality?.cc_fec : null;
  $('#digital-quality').textContent = fec?.valid && Number.isFinite(fec.ok_pct) ? `${fec.ok_pct.toFixed(1)}% valid` : '—';
  const calls = active && integrated ? digital.calls.filter(call => call.state === 2 || call.state === 3) : [];
  $('#digital-calls').innerHTML = calls.length ? calls.map(call => `<article class="digital-call ${call.state === 2 ? 'on-air' : ''}"><div class="digital-call-heading"><span>${call.slot === 1 ? 'SLOT 2' : 'SLOT 1'} · ${call.state === 2 ? 'ON AIR' : 'ENDED'}</span><b class="${call.enc ? 'encrypted' : ''}">${call.enc ? 'ENCRYPTED · MUTED' : 'CLEAR'}</b></div><strong>${escapeHtml(call.name || call.tg_text || (call.tg_id ? 'Talkgroup ' + call.tg_id : 'Digital call'))}</strong><div class="digital-call-identity"><span>TG ${escapeHtml(call.tg_id || call.tg_text || '—')}</span><span>RADIO ${escapeHtml(call.ota_source_id || call.src_text || '—')}</span></div><small>${escapeHtml(call.src_text || call.channel || '')}${call.emergency ? ' · EMERGENCY' : ''}</small></article>`).join('') : '<div class="digital-call-empty">Waiting for decoded calls…</div>';
}

function addDigitalEvent(event) {
  const index = state.digitalEvents.findIndex(row => row.key === event.key);
  if (index >= 0) state.digitalEvents[index] = event; else state.digitalEvents.push(event);
  state.digitalEvents = state.digitalEvents.slice(-100); renderDigitalEvents();
}
function renderDigitalEvents() {
  $('#digital-events').innerHTML = state.digitalEvents.length ? [...state.digitalEvents].reverse().map(event => {
    const time = Number(event.event_time) > 0 ? new Date(Number(event.event_time) * 1000).toLocaleTimeString([], { hour12:false }) : '—';
    const ids = [event.target_id ? 'TG ' + event.target_id : event.tgt_str, event.source_id ? 'ID ' + event.source_id : event.src_str].filter(Boolean).join(' / ') || '—';
    return `<tr class="${event.enc ? 'event-encrypted' : ''}"><td>${escapeHtml(time)}</td><td>${escapeHtml(event.sysid_string || '—')}</td><td>${escapeHtml(ids)}</td><td>${escapeHtml(event.event || event.internal || event.text || event.t_name || 'Decoded frame')}${event.enc ? ' · Encrypted' : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="decode-empty">Events appear when the decoder receives valid frames.</td></tr>';
}
function addDigitalLog(message) {
  state.digitalLogs.push(String(message).trim()); state.digitalLogs = state.digitalLogs.slice(-80);
  $('#digital-log').textContent = state.digitalLogs.join('\n');
}
function channelModeTag(value) { const channel=typeof value==='string'?{mode:value}:value; return `<span class="mode-tag ${DIGITAL.has(channel.mode)?'digital':''}">${escapeHtml(protocolLabel(channel))}</span>`; }
function escapeHtml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
function renderChannels() {
  $('#channel-count').textContent = String(state.channels.length).padStart(2,'0');
  const collection = $('#collection-list'); collection.replaceChildren();
  const groups = [...new Set(state.channels.map(c => c.group || 'General'))].slice(0,5);
  if (!groups.length) collection.innerHTML = '<div class="collection-empty">No saved memories yet.<br>Add a channel to get started.</div>';
  for (const group of groups) {
    const count = state.channels.filter(c => (c.group || 'General') === group).length;
    const button = document.createElement('button'); button.className = 'collection-item'; button.innerHTML = `<i class="collection-dot"></i><span class="collection-name">${escapeHtml(group)}</span><small>${count}</small>`;
    button.addEventListener('click', () => { setPage('channels'); $('#channel-search').value = ''; $('#channel-filter').value = 'all'; renderChannelRows(); }); collection.append(button);
  }
  const quick = $('#quick-channels'); quick.replaceChildren();
  const quickChannels = state.channels.slice(0,4);
  if (!quickChannels.length) quick.innerHTML = '<div class="collection-empty">Your saved frequencies will appear here.</div>';
  for (const channel of quickChannels) {
    const button = document.createElement('button'); button.className = 'quick-channel';
    const freq = channel.kind === 'trunked' ? formatFrequency(channel.frequency || 0) : formatMHz(channel.frequency,6);
    button.innerHTML = `<i class="quick-dot"></i><span class="quick-info"><strong>${escapeHtml(channel.name)}</strong><small>${escapeHtml(freq)}${channel.kind === 'trunked' ? '' : ' MHz'}</small></span><span class="quick-mode">${escapeHtml(channel.mode || 'NFM')}</span>`;
    button.addEventListener('click', () => tuneChannel(channel)); quick.append(button);
  }
  renderDigitalSystems();
  renderChannelRows();
}
function renderDigitalSystems() {
  const systems=state.channels.filter(channel=>channel.kind==='trunked');
  const picker=$('#digital-system-picker'),select=$('#digital-system'),siteSelect=$('#digital-site');
  const scanOption=$('.digital-scan-option'),scanCheckbox=$('#digital-scan');
  picker.classList.toggle('hidden',systems.length===0);
  if(!systems.length)state.selectedTrunkId='';
  if(!systems.some(system=>system.id===state.selectedTrunkId))state.selectedTrunkId='';
  select.replaceChildren();
  const conventional=document.createElement('option');conventional.value='';conventional.textContent='Conventional · current frequency';select.append(conventional);
  for(const system of systems){const option=document.createElement('option');option.value=system.id;option.textContent=system.name;select.append(option);}
  select.value=state.selectedTrunkId;
  const current=systems.find(system=>system.id===state.selectedTrunkId);
  siteSelect.replaceChildren();
  if(current)for(const site of current.sites||[]){const option=document.createElement('option');option.value=site.id;option.textContent=site.name;siteSelect.append(option);}
  siteSelect.disabled=!current?.sites?.length;
  scanOption.classList.toggle('hidden',Boolean(current));scanCheckbox.disabled=Boolean(current);if(current)scanCheckbox.checked=false;
  if(current?.mode)$('#digital-protocol').value=protocolChoice(current);
  renderDigital();
}
function trunkControlFrequencies(channel) {
  const result=[];
  for(const site of channel.sites||[]){
    const saved=(site.frequencies||[]).filter(item=>['d','a'].includes(item.use));
    const candidates=saved.length?saved:[(site.frequencies||[])[0]||{frequency:channel.frequency}];
    for(const item of candidates){const frequency=Number(item.frequency);if(Number.isFinite(frequency)&&frequency>=10000&&!result.some(row=>row.siteId===site.id&&row.frequency===frequency))result.push({siteId:site.id,frequency});}
  }
  if(!result.length&&Number(channel.frequency)>=10000)result.push({siteId:'main',frequency:Number(channel.frequency)});
  return result;
}
function renderChannelRows() {
  const query = ($('#channel-search')?.value || '').toLowerCase().trim();
  const filter = $('#channel-filter')?.value || 'all';
  const rows = $('#channel-rows'); rows.replaceChildren();
  const selectedTrunked=state.channels.some(channel=>state.scanSelection.has(channel.id)&&channel.kind==='trunked');
  const selectedConventional=state.channels.some(channel=>state.scanSelection.has(channel.id)&&channel.kind!=='trunked');
  const filtered = state.channels.filter(channel => {
    if (filter !== 'all' && channel.kind !== filter) return false;
    const text = [channel.name,channel.group,channel.notes,protocolLabel(channel),formatFrequency(channel.frequency),channel.source].join(' ').toLowerCase();
    return !query || text.includes(query);
  });
  $('#channels-empty').classList.toggle('hidden', filtered.length > 0);
  for (const channel of filtered) {
    const row = document.createElement('div'); row.className = `channel-row ${channel.kind === 'trunked' ? 'trunked' : ''}`;
    const freq = channel.kind === 'trunked' ? (channel.frequency ? formatFrequency(channel.frequency) : `${channel.sites?.length || 0} sites`) : formatMHz(channel.frequency,6);
    const detail = channel.kind === 'trunked' ? `${channel.sites?.length || 0} sites · ${channel.talkgroups?.length || 0} talkgroups` : channel.notes || 'Conventional memory';
    const sourceClass = channel.source === 'RadioReference' ? 'rr' : '';
    const isTrunked=channel.kind==='trunked',hasControls=trunkControlFrequencies(channel).length>0;
    const conflict=isTrunked?selectedConventional:selectedTrunked;
    const disabled=channel.mode==='HD'||(!isTrunked&&channel.enabled===false)||(isTrunked&&!hasControls)||conflict;
    const title=isTrunked?'Scan this system’s saved site control frequencies':channel.mode==='HD'?'Tune HD memories individually; digital acquisition takes time':channel.enabled===false?'Enable this memory before scanning':conflict?'Clear the other scan type before selecting this memory':'Include in the selected memory scan';
    row.innerHTML = `<div class="channel-name-cell"><input type="checkbox" class="scan-memory-checkbox" data-scan-id="${escapeHtml(channel.id)}" aria-label="Scan ${escapeHtml(channel.name)}" ${state.scanSelection.has(channel.id)?'checked':''} ${disabled?'disabled':''} title="${escapeHtml(title)}"><span class="channel-type-icon">${channel.kind === 'trunked' ? '⌘' : '⌁'}</span><div><strong>${escapeHtml(channel.name)}</strong><small>${escapeHtml(detail)}</small></div></div><span class="freq-cell">${escapeHtml(freq)}${channel.kind === 'trunked' || freq.includes('GHz') || freq.includes('MHz') || freq.includes('kHz') ? '' : ' MHz'}</span>${channelModeTag(channel)}<span>${escapeHtml(channel.group || 'General')}</span><span class="source-tag ${sourceClass}">${escapeHtml(channel.source || 'Manual')}</span><div class="channel-actions"><button data-action="tune" title="Tune">▶</button><button data-action="edit" title="Edit">✎</button><button data-action="delete" title="Delete">×</button></div>`;
    row.querySelector('[data-scan-id]').addEventListener('change',event=>{event.target.checked?state.scanSelection.add(channel.id):state.scanSelection.delete(channel.id);renderChannelRows();});
    row.querySelector('[data-action="tune"]').addEventListener('click', () => tuneChannel(channel));
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openChannelDialog(channel));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteChannel(channel));
    rows.append(row);
  }
  renderScanStatus();
}
function addActivity(channel, kind='TUNE') {
  state.activity.unshift({ time:new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()), name:channel.name, frequency:channel.frequency, mode:channel.mode, kind });
  state.activity = state.activity.slice(0,12); renderActivity();
}
function renderActivity() {
  const list = $('#activity-log'); list.replaceChildren();
  if (!state.activity.length) { list.innerHTML = '<div class="activity-empty"><span>⌁</span><div><strong>Nothing on the air yet</strong><small>Received signals will appear here as you tune around.</small></div></div>'; return; }
  for (const entry of state.activity) {
    const row = document.createElement('div'); row.className = 'activity-row';
    row.innerHTML = `<span class="activity-time">${escapeHtml(entry.time)}</span><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(entry.mode)} · ${formatMHz(entry.frequency,3)}</span>`; list.append(row);
  }
}
async function tuneChannel(channel) {
  if (isHdActive()) { try { state.status = await api('/api/hd/stop', {}); } catch(error) { toast(error.message,'error');return; } }
  if(isDigitalActive()){await stopDigital();if(isDigitalActive())return;}
  if (channel.mode === 'HD') { setFrequencyDisplay(channel.frequency);$('#mode-select').value='HD';setPage('radio');await state.hdUi.toggle(channel.id);addActivity(channel);return; }
  if (channel.kind === 'trunked') { state.selectedTrunkId=channel.id;state.decoderMemoryId='';renderDigitalSystems();$('#digital-protocol').value=protocolChoice(channel);setPage('decoders');toast(`${channel.name} · ${protocolLabel(channel)} selected. Choose a site and start the decoder.`);return; }
  state.selectedTrunkId='';state.decoderMemoryId=channel.id;renderDigitalSystems();if(DIGITAL.has(channel.mode))$('#digital-protocol').value=protocolChoice(channel);
  $('#mode-select').value = channel.mode || 'NFM'; modeHint($('#mode-select').value); setFrequencyDisplay(channel.frequency);
  try { await api('/api/tune',{ frequency:channel.frequency }); await api('/api/mode',{ mode:channel.mode || 'NFM' }); }
  catch (error) { if (isConnected()||isDigitalActive()) {toast(error.message,'error');return;} }
  state.status = { ...(state.status||{}), frequency:channel.frequency, mode:channel.mode || 'NFM', selectedChannelId:channel.id }; renderStatus(); addActivity(channel);
  if (state.page !== 'radio') setPage('radio');
}
function openChannelDialog(channel=null, {draft=false}={}) {
  const form = $('#channel-form'); form.reset();
  const editing=Boolean(channel?.id)&&!draft;
  state.editingChannel=editing?structuredClone(channel):null;state.channelSource=channel?.source||'Manual';
  $('#channel-dialog-title').textContent = editing ? 'Edit memory channel' : draft ? 'Save current channel' : 'New memory channel';
  $('#channel-id').value = editing ? channel.id : '';
  $('#channel-name').value = channel?.name || '';
  $('#channel-frequency').value = channel ? formatMHz(channel.frequency) : formatMHz(Number($('#frequency-input').value)*1e6 || 100000000);
  $('#channel-mode').value = channel?.mode || $('#mode-select').value || 'NFM';
  $('#channel-kind').value = channel?.kind || 'conventional'; $('#channel-group').value = channel?.group || 'General'; $('#channel-notes').value = channel?.notes || '';
  $('#channel-p25-phase').value=channel?.p25Phase||(channel?'auto':'1');$('#channel-p25-control').value=channel?.p25Control||'phase1';$('#channel-p25-modulation').value=channel?.p25Modulation||'auto';
  $('#channel-p25-wacn').value=channel?.p25Wacn||'';$('#channel-p25-system-id').value=channel?.p25SystemId||'';$('#channel-p25-nac').value=channel?.p25Nac||'';$('#channel-nxdn-mode').value=channel?.nxdnMode||'NXDN48';
  $('#channel-hd-program').value=String(channel?.hdProgram ?? state.hdUi?.program ?? 0);
  const site=channel?.sites?.[0];$('#channel-site-name').value=site?.name||'Main site';
  $('#channel-site-frequencies').value=(site?.frequencies||[]).map(item=>`${item.lcn!==null&&item.lcn!==undefined&&item.lcn!==''?item.lcn+', ':''}${formatMHz(item.frequency)}, ${item.use==='d'?'control':item.use==='a'?'alternate':'voice'}`).join('\n');
  $('#channel-preserved-sites').textContent=channel?.sites?.length>1?`This edits the primary site. ${channel.sites.length-1} other site(s) and ${channel.talkgroups?.length||0} talkgroups are retained.`:'';
  updateChannelProtocolFields();$('#save-channel').disabled=false;$('#channel-dialog').returnValue='';
  $('#channel-dialog').showModal();
}
async function saveCurrentMemory(page) {
  const button=$(page==='decoders'?'#digital-add-memory':'#save-current-memory');button.disabled=true;
  const input={page,frequency:Math.round(Number($(page==='decoders'?'#digital-frequency-input':'#frequency-input').value)*1e6),mode:$('#mode-select').value,hdProgram:state.hdUi?.program||0,decoderChoice:$('#digital-protocol').value,selectedMemoryId:state.selectedTrunkId||state.decoderMemoryId,siteId:$('#digital-site').value};
  try {
    const fresh=await api('/api/state');
    const draft=currentMemoryDraft({...input,status:fresh.status,channels:fresh.channels});
    openChannelDialog(draft,{draft:true});
  }catch(error){toast(error.message,'error');}
  finally{button.disabled=false;}
}
function updateChannelProtocolFields() {
  const trunked=$('#channel-kind').value==='trunked',select=$('#channel-mode');
  for(const option of select.options)option.disabled=trunked&&!DIGITAL.has(option.value);
  if(trunked&&!DIGITAL.has(select.value))select.value='P25';
  const p25=select.value==='P25';
  $('#channel-p25-fields').classList.toggle('hidden',!p25);$('#channel-nxdn-fields').classList.toggle('hidden',select.value!=='NXDN');$('#channel-trunk-fields').classList.toggle('hidden',!trunked);
  $('#channel-hd-fields').classList.toggle('hidden',select.value!=='HD');
  if($('#channel-p25-phase').value==='1')$('#channel-p25-control').value='phase1';
  $('#channel-p25-control-field').classList.toggle('hidden',!trunked||$('#channel-p25-phase').value==='1');
  $('#channel-frequency-label').textContent=trunked?'PRIMARY CONTROL FREQUENCY (MHz)':'FREQUENCY (MHz)';
}
async function saveChannel(event) {
  event.preventDefault();
  if(event.submitter?.value==='cancel'){$('#channel-dialog').close('cancel');return;}
  const id = $('#channel-id').value;
  const frequency = Number($('#channel-frequency').value) * 1e6;
  if (!Number.isFinite(frequency) || frequency < 10000) { toast('Enter the memory frequency in MHz.','error'); return; }
  const body = { name:$('#channel-name').value, frequency:Math.round(frequency), mode:$('#channel-mode').value, kind:$('#channel-kind').value, group:$('#channel-group').value || 'General', notes:$('#channel-notes').value, source:state.channelSource||'Manual' };
  try {
    if(body.mode==='HD')Object.assign(body,hdMemoryOptions({...body,hdProgram:$('#channel-hd-program').value}));
    if(DIGITAL.has(body.mode))Object.assign(body,digitalOptions({mode:body.mode,p25Phase:$('#channel-p25-phase').value,p25Control:$('#channel-p25-control').value,p25Modulation:$('#channel-p25-modulation').value,p25Wacn:$('#channel-p25-wacn').value,p25SystemId:$('#channel-p25-system-id').value,p25Nac:$('#channel-p25-nac').value,nxdnMode:$('#channel-nxdn-mode').value}));
    if(body.kind==='trunked'){const old=state.editingChannel?.sites||[];body.sites=[{...(old[0]||{}),id:old[0]?.id||'main',name:$('#channel-site-name').value.trim()||'Main site',frequencies:siteFrequencies($('#channel-site-frequencies').value,body.frequency)},...old.slice(1)];}
    $('#save-channel').disabled=true;
    if (id) await requestApi(`/api/channels/${encodeURIComponent(id)}`,body,'PUT'); else await api('/api/channels',body);
    await refreshState(); $('#channel-dialog').close('saved'); toast(id ? 'Memory channel updated.' : 'Memory channel saved.','success');
  } catch (error) { toast(error.message,'error'); }
  finally{$('#save-channel').disabled=false;}
}
async function requestApi(url, body, method) {
  const response = await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const result=await response.json(); if(!response.ok)throw new Error(result.error||'Request failed.'); return result;
}
async function deleteChannel(channel) {
  if (!confirm(`Delete “${channel.name}” from your memory channels?`)) return;
  try { await fetch(`/api/channels/${encodeURIComponent(channel.id)}`,{method:'DELETE'}); await refreshState(); toast('Memory channel deleted.'); }
  catch (error) { toast(error.message,'error'); }
}
function openRadioReferenceDialog() {
  $('#rr-error').classList.add('hidden'); $('#rr-form').reset(); $('#rr-import-kind').dispatchEvent(new Event('change')); $('#rr-dialog').showModal();
}
async function importRR(event) {
  event.preventDefault();if(event.submitter?.value==='cancel'){$('#rr-dialog').close('cancel');return;} const button = $('#rr-submit'); button.disabled = true; button.textContent = 'Importing…'; $('#rr-error').classList.add('hidden');
  try {
    const kind=$('#rr-import-kind').value;
    const response = await fetch('/api/radioreference/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,systemId:$('#rr-system-id').value,zip:$('#rr-zip').value,appKey:$('#rr-app-key').value,username:$('#rr-username').value,password:$('#rr-password').value})});
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'RadioReference import failed.');
    $('#rr-password').value=''; $('#rr-username').value=''; await refreshState(); $('#rr-dialog').close();
    if(result.kind==='conventional')toast(`Imported ${result.imported} frequencies for ${result.city ? `${result.city}, ` : ''}${result.county}.${result.updated ? ` Corrected ${result.updated} existing RadioReference channel${result.updated===1?'':'s'} to digital mode.` : ''}`,'success');
    else toast(`Imported ${result.channel.name}: ${result.importedSites} sites, ${result.importedTalkgroups} talkgroups.`,'success');
  } catch (error) { $('#rr-error').textContent = error.message; $('#rr-error').classList.remove('hidden'); }
  finally { button.disabled=false; button.textContent='Import system'; }
}
function parseCsv(text) {
  const rows=[]; let row=[], field='', quoted=false;
  for(let i=0;i<text.length;i++) { const c=text[i]; if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}else if(c!=='\r')field+=c; }
  if(field||row.length){row.push(field);rows.push(row);} return rows;
}
async function importChannelsFile(file) {
  try {
    const content = await file.text(); let imported=[];
    if (file.name.toLowerCase().endsWith('.json')) {
      const parsed=JSON.parse(content); imported=Array.isArray(parsed)?parsed:parsed.channels||[];
    } else {
      const rows=parseCsv(content); const headers=(rows.shift()||[]).map(h=>h.trim().toLowerCase());
      imported=rows.filter(r=>r.length>1).map(row=>{const get=(...names)=>{const i=headers.findIndex(h=>names.includes(h));return i>=0?row[i]:'';};let frequency=Number(get('frequency','freq','frequency (mhz)'));if(frequency>0&&frequency<100000)frequency*=1e6;return{name:get('name','channel','alpha','description')||'Imported channel',frequency,mode:get('mode','demod')||'NFM',group:get('group','category')||'Imported',notes:get('notes','description'),kind:'conventional',source:'CSV'};});
    }
    let count=0;
    for(const row of imported){let frequency=Number(row.frequency);if(frequency>0&&frequency<100000)frequency*=1e6;if(!frequency)continue;const body={...row,frequency:Math.round(frequency)};await api('/api/channels',body);count++;}
    await refreshState(); toast(`Imported ${count} memory channel${count===1?'':'s'}.`,count?'success':'');
  }catch(error){toast(`Could not import file: ${error.message}`,'error');}
}
function exportChannels() {
  const blob=new Blob([JSON.stringify({channels:state.channels},null,2)],{type:'application/json'}); const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='signal-outpost-memories.json';link.click();URL.revokeObjectURL(link.href);toast('Memory channels exported.','success');
}
async function startListening() {
  const mode=$('#mode-select').value, freq=Math.round(Number($('#frequency-input').value)*1e6);
  if (isHdActive() || mode === 'HD') { await state.hdUi.toggle(); return; }
  if(isDigitalActive()){await stopDigital();return;}
  if(DIGITAL.has(mode)) { await toggleDigital(mode);setPage('decoders');return; }
  if (isConnected()) { try { await api('/api/rtl/stop',{}); await stopAudio(); state.status={...(state.status||{}),connected:false};renderStatus();toast('Receiver stopped.'); } catch(error){toast(error.message,'error');} return; }
  await stopDigital();
  try {
    $('#connect-button').disabled = true;
    if (!await saveSettings({silent:true})) return;
    const result=await api('/api/rtl/start',{frequency:freq,mode,gain:state.settings.tunerGain||0,sampleRate:Number(state.settings.sampleRate||2400000)});
    state.status=result; renderStatus(); await connectSocket(); await setupAudio(); toast('RTL-SDR receiver connected.','success');
  }catch(error){toast(error.message,'error');}
  finally { $('#connect-button').disabled = false; }
}
async function stopDigital() {
  if(!isDigitalActive()&&!state.status?.digitalStarting)return;
  try { state.status=await api('/api/digital/stop',{});await stopAudio();renderStatus();toast('Digital decoder stopped.'); }
  catch(error){toast(error.message,'error');}
}
async function toggleDigital(protocol) {
  if(state.digitalBusy)return;
  state.digitalBusy=true;renderDigital();
  try {
    if(isDigitalActive()){await stopDigital();return;}
    const launchBody=digitalLaunchBody(protocol);
    if(state.settings.digitalEngine!=='external')await setupAudio();
    state.digitalEvents=[];state.digitalLogs=[];renderDigitalEvents();$('#digital-log').textContent='Starting decoder…';
    const result=await api('/api/digital/start',launchBody);
    state.status={...(state.status||{}),digitalActive:true,hdActive:false,connected:false,frequency:result.frequency,mode:result.protocol,digital:result.digital||{engine:'external',phase:'listening'}};
    state.spectrum=null;renderStatus();toast(`${result.protocolLabel || result.protocol} decoder listening.`,'success');
  }catch(error){toast(error.message,'error');await refreshState().catch(()=>{});}
  finally{state.digitalBusy=false;renderDigital();}
}
async function tuneFromInput() {
  const freq=Math.round(Number($('#frequency-input').value)*1e6);
  if(!Number.isFinite(freq)||freq<10000){toast('Enter a frequency in MHz.','error');return;}
  setFrequencyDisplay(freq);
  try { state.status=await api('/api/tune',{frequency:freq}); } catch(error) { if(isConnected()||isDigitalActive())toast(error.message,'error'); }
  renderStatus();
}
async function changeMode(mode) {
  if(isDigitalActive()){$('#mode-select').value=state.status.mode;toast('Stop the digital decoder before changing its protocol.');return;}
  modeHint(mode); $('#connect-button .listen-label').textContent=DIGITAL.has(mode)?'Start decoder':isConnected()?'Stop listening':'Start listening';
  try { state.status=await api('/api/mode',{mode,program:state.hdUi?.program||0});renderStatus(); } catch(error){$('#mode-select').value=state.status.mode;toast(error.message,'error');}
  state.hdUi?.render();
}
async function toggleScan() {
  if(!state.scanning){await startSelectedScan();return;}
  try { state.status=await api('/api/scan/stop',{});await stopAudio();renderStatus();toast('Scan and live RF stopped.'); }
  catch(error){toast(error.message,'error');}
}
function renderScanStatus() {
  const active=Boolean(state.scan?.active),scan=state.scan;
  const selected=state.channels.filter(channel=>state.scanSelection.has(channel.id));
  const trunked=selected.length>0&&selected.every(channel=>channel.kind==='trunked');
  const mixed=selected.some(channel=>channel.kind==='trunked')&&!trunked;
  const digital=!trunked&&!mixed&&selected.length>0&&selected.every(channel=>DIGITAL.has(channel.mode));
  const controls=trunked?selected.reduce((sum,channel)=>sum+trunkControlFrequencies(channel).length,0):0;
  const scanSpeed=$('#scan-speed');
  const scanType=trunked?'trunked':digital?'digital':'native';
  const speedOptions=trunked?[[1000,'Fastest · 1 second / control frequency'],[2000,'Rapid · 2 seconds / control frequency'],[3000,'Rapid · 3 seconds / control frequency'],[5000,'5 seconds / control frequency'],[10000,'10 seconds / control frequency'],[20000,'20 seconds / control frequency'],[30000,'30 seconds / control frequency']]:digital?[[150,'Rapid · fastest decoder timing'],[1500,'Standard · 1 second dwell']]:[[80,'Fastest · 80 ms'],[150,'Rapid · 150 ms'],[250,'Rapid · 250 ms'],[500,'Standard · 500 ms'],[1500,'Standard · 1.5 seconds']];
  if(state.scanControlMode!==scanType){const previous=Number(scanSpeed.value);scanSpeed.replaceChildren(...speedOptions.map(([value,label])=>{const option=document.createElement('option');option.value=String(value);option.textContent=label;return option;}));scanSpeed.value=speedOptions.some(([value])=>value===previous)?String(previous):String(trunked?2000:digital?150:150);state.scanControlMode=scanType;}
  $('#scan-hold').disabled=digital;$('#scan-hang').disabled=digital;
  $('#scan-selection-count').textContent=trunked?`${selected.length} trunked system${selected.length===1?'':'s'} · ${controls} control frequenc${controls===1?'y':'ies'}`:`${state.scanSelection.size} channel${state.scanSelection.size===1?'':'s'} selected`;
  const selectTrunked=trunked||(!selected.length&&$('#channel-filter').value==='trunked');
  $('#scan-select-visible').textContent=selectTrunked?'Select visible trunked systems':'Select visible conventional';
  $('#scan-selected').textContent=trunked?'▶ Scan control channels':'▶ Scan selected';
  $('#scan-selected').disabled=active||state.scanSelection.size===0||mixed;$('#scan-stop').disabled=!active;$('#scan-skip').disabled=!active||!(['native','trunked'].includes(scan?.engine)||state.status?.digital?.engine==='integrated');
  $('#memory-scan-status').classList.toggle('holding',Boolean(scan?.holding));
  const note=$('.scan-digital-note');
  if(!active){
    if(trunked){$('#memory-scan-status').textContent=`The integrated decoder will rotate through ${controls} saved primary / alternate control frequencies while keeping the RTL-SDR session open. One tuner checks them sequentially; calls can be missed while it is on another site.`;note.textContent='Choose 1–30 seconds per control frequency. Frequency changes retune the open tuner; selected systems must use matching decoder settings. Hold on an active signal keeps the decoder on a call until it ends.';}
    else if(digital){$('#memory-scan-status').textContent='Digital memories use native decoder scan timing and activity hold. Select a matching protocol group.';note.textContent='Digital selections use the integrated decoder. Group NXDN48 and NXDN96 separately. Trunked systems follow their site and talkgroups from Decoders.';}
    else {$('#memory-scan-status').textContent=mixed?'Clear the current selection, then choose either trunked systems or conventional memories.':'Select conventional memories using the checkboxes below. One USB tuner visits the selected frequencies in sequence.';note.textContent='Digital selections use the integrated decoder. Group NXDN48 and NXDN96 separately. Trunked systems follow their site and talkgroups from Decoders.';}
    return;
  }
  if(scan.engine==='trunked'){
    const current=scan.current;
    $('#memory-scan-status').textContent=`Trunked control scan · ${scan.index+1}/${scan.total} · ${current?.systemName||'System'} / ${current?.siteName||'Site'} · ${formatMHz(current?.frequency||0,6)} MHz · ${scan.activity||'Monitoring'} · ${scan.dwellMs/1000}s per frequency`;
  }else{
    const kind=scan.engine==='digital'?'Digital decoder scan':scan.rapid?'Rapid scan':'Memory scan';
    $('#memory-scan-status').textContent=scan.engine==='digital'?`${kind} · ${scan.channelCount} selected memories · ${scan.rapid?'fastest decoder timing':'1 second dwell'}${scan.channel ? ' · '+scan.channel.name : ''} · see Decoders for activity`:`${kind} · ${scan.channelCount} selected · ${scan.dwellMs} ms dwell · ${scan.holding?'Listening to':'Checking'} ${scan.channel?.name||'receiver'} · ${scan.hops||0} visits`;
  }
  $('#memory-scan-status').classList.toggle('holding',Boolean(scan.holding));
}
async function startSelectedScan() {
  $('#scan-selected').disabled=true;
  try {
    const selected=state.channels.filter(channel=>state.scanSelection.has(channel.id)),trunked=selected.length>0&&selected.every(channel=>channel.kind==='trunked');
    if(!selected.length)throw new Error('Select at least one memory channel to scan.');
    if(selected.some(channel=>channel.kind==='trunked')&&!trunked)throw new Error('Select either trunked systems or conventional memories, not both.');
    if(state.settings.digitalEngine!=='external'&&(trunked||selected.some(channel=>DIGITAL.has(channel.mode))))await setupAudio();
    const dwellMs=Number($('#scan-speed').value),result=await api('/api/scan/start',{channelIds:selected.map(channel=>channel.id),rapid:dwellMs<500,dwellMs,holdOnSignal:$('#scan-hold').checked,holdMs:Number($('#scan-hang').value)});
    state.status={...(state.status||{}),scannerActive:true,scan:result.scan,digitalActive:['digital','trunked'].includes(result.scan.engine),connected:result.scan.engine==='native'};
    renderStatus();toast(trunked?`Scanning ${result.scan.controlCount} trunked control frequencies.`:`Scanning ${result.scan.channelCount} selected memories.`,'success');
  }catch(error){toast(error.message,'error');}
  finally{renderScanStatus();}
}
function digitalLaunchBody(protocol) {
  const memory=state.channels.find(channel=>channel.id===state.decoderMemoryId);
  const frequency=Math.round(Number($(protocol?'#frequency-input':'#digital-frequency-input').value)*1e6);
  if(!state.selectedTrunkId&&!memory&&!$('#digital-scan').checked&&(!Number.isFinite(frequency)||frequency<10000||frequency>1766000000))throw new Error('Enter a digital frequency between 0.010 and 1766 MHz.');
  return {protocol:protocol||$('#digital-protocol').value,frequency,channelId:state.selectedTrunkId||undefined,memoryId:!state.selectedTrunkId&&memory&&DIGITAL.has(memory.mode)?memory.id:undefined,siteId:$('#digital-site').value,scanMemories:$('#digital-scan').checked&&!state.selectedTrunkId};
}
async function setupAudio() {
  if(audioContext){if(audioContext.state==='suspended')await audioContext.resume();return;}
  const Context=window.AudioContext||window.webkitAudioContext;if(!Context){$('#audio-state').textContent='Audio unavailable';return;}
  try{audioContext=new Context({sampleRate:48000});}catch{audioContext=new Context();} if(audioContext.state==='suspended')await audioContext.resume();
  if(state.settings.audioOutputId&&typeof audioContext.setSinkId==='function')try{await audioContext.setSinkId(state.settings.audioOutputId);}catch{}
  scriptNode=audioContext.createScriptProcessor(4096,1,2);audioGain=audioContext.createGain();audioGain.gain.value=state.muted?0:state.volume;
  scriptNode.onaudioprocess=event=>{
    audioQueue.render(event.outputBuffer.getChannelData(0),event.outputBuffer.getChannelData(1),event.outputBuffer.sampleRate);
  };
  silentSource=audioContext.createConstantSource();silentSource.offset.value=0;silentSource.connect(scriptNode);silentSource.start();scriptNode.connect(audioGain);audioGain.connect(audioContext.destination);
  $('#audio-state').textContent='Audio ready';
}
async function stopAudio() {
  const oldSource=silentSource,oldNode=scriptNode,oldGain=audioGain,oldContext=audioContext;
  silentSource=null;scriptNode=null;audioGain=null;audioContext=null;audioQueue=new PlaybackBuffer();
  try{oldSource?.stop();oldSource?.disconnect();oldNode?.disconnect();oldGain?.disconnect();await oldContext?.close();}catch{}
}
function queueAudio(data) {
  if(state.wideSurvey?.running)return;
  if(!state.status?.connected&&!state.status?.hdActive&&!(state.status?.digitalActive&&state.status?.digital?.engine==='integrated'))return;
  if(!audioContext)setupAudio().catch(()=>{});
  const header=new DataView(data),stereo=data.byteLength>=8&&header.getUint32(0,false)===0x48444131&&header.getUint32(4,true)===2;
  audioQueue.push(new Float32Array(data,stereo?8:0),stereo?2:1);
  $('#audio-state').textContent=audioQueue.playing?'Live audio':'Buffering audio';
}
function renderPlaybackDiagnostics() {
  state.playbackDiagnostics={...audioQueue.snapshot(),contextState:audioContext?.state||'stopped',outputRate:audioContext?.sampleRate||0};
  state.hdUi?.render();
}
function connectSocket() {
  if(state.socket&&state.socket.readyState<2)return;
  const scheme=location.protocol==='https:'?'wss':'ws';const socket=new WebSocket(`${scheme}://${location.host}/stream`);socket.binaryType='arraybuffer';state.socket=socket;
  socket.onmessage=event=>{
    if(typeof event.data!=='string'){queueAudio(event.data);return;}
    let message;try{message=JSON.parse(event.data);}catch{return;}
    if (message.type.startsWith('meshcore-')) { state.meshcore?.handleMessage(message); return; }
    if(message.type==='status'){state.status=message.status;renderStatus();}
    else if(message.type==='hd-state'){
      state.status={...state.status,hd:message.hd,hdActive:message.hd.active};
      if(message.hd.active)Object.assign(state.status,{frequency:message.hd.frequency,mode:'HD',sampleRate:message.hd.sampleRate,rtlInfo:message.hd.info,connected:false,digitalActive:false});
      renderStatus();
    }
    else if(message.type==='hd-error'){toast(message.message,'error');}
    else if(message.type==='spectrum')receiveSpectrum(message);
    else if(message.type==='meter'){const level=Math.max(0,Math.min(100,message.level*100));$('#audio-meter').style.width=`${level}%`;}
    else if(message.type==='scan'||message.type==='scan-hold'){if(message.scan){state.status={...state.status,scannerActive:true,scan:message.scan};}const channel=message.channel;if(channel){setFrequencyDisplay(channel.frequency);$('#mode-select').value=channel.mode||'NFM';modeHint(channel.mode||'NFM');state.status={...state.status,frequency:channel.frequency,mode:channel.mode||'NFM'};renderStatus();}}
    else if(message.type==='scan-error'){toast(message.message,'error');}
    else if(message.type==='scan-lock'){state.scanning=false;renderStatus();if(message.channel){addActivity(message.channel,'LOCK');toast(`Signal activity on ${message.channel.name}.`,'success');}}
    else if(message.type==='ft8')addFt8Decode(message.decode);
    else if(message.type==='cw-text'){state.cwText=message.text;$('#cw-transcript').textContent=state.cwText;$('#cw-state').classList.toggle('active',Boolean(state.cwText));}
    else if(message.type==='digital-log')addDigitalLog(message.message);
    else if(message.type==='digital-event')addDigitalEvent(message.event);
    else if(message.type==='digital-state'){
      state.status={...state.status,digital:message.digital,digitalActive:['starting','listening'].includes(message.digital.phase),frequency:message.frequency||state.status?.frequency,gain:message.gain??state.status?.gain,scan:message.scan,scannerActive:Boolean(message.scan?.active)};
      renderStatus();
    }
    else if(message.type==='digital-error'){addDigitalLog(message.message);toast(message.message,'error');}
    else if(message.type==='log'&&message.message)toast(message.message.slice(0,180),'error');
  };
  socket.onopen=()=>state.meshcore?.socketOpened();socket.onclose=()=>{state.meshcore?.socketClosed();state.socket=null;if(document.visibilityState==='visible')setTimeout(connectSocket,1200);};socket.onerror=()=>{};
}
function fitCanvas(canvas, context) {
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);const width=Math.max(1,Math.floor(rect.width*dpr)),height=Math.max(1,Math.floor(rect.height*dpr));
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;context.setTransform(dpr,0,0,dpr,0,0);return true;}return false;
}
function receiveSpectrum(frame) {
  if(!Array.isArray(frame.bins)||frame.bins.length<2||!Number.isFinite(frame.center)||!(frame.span>0))return;
  const received={...frame,receivedAt:Date.now()};state.lastLiveSpectrum=received;
  if(state.wideSurvey?.running)return;
  const epoch=frame.epoch||`${frame.source}:${frame.center}:${frame.span}`;
  if(epoch!==state.spectrumEpoch)for(const view of spectrumViews)view.center=null;
  if(epoch!==state.spectrumEpoch){state.rfHistory=[];state.spectrumEpoch=epoch;}
  state.spectrum={...received,epoch};
  state.rfHistory.push(Float32Array.from(frame.bins));if(state.rfHistory.length>300)state.rfHistory.shift();
  drawSpectrum();drawWaterfall();renderSpectrumStatus();
}
function activeSpectrumView(){return spectrumViews.find(view=>view.page===state.page);}
let spectrumColors;
function drawSpectrum(force=false) {
  const view=activeSpectrumView();if(!view||view.page==='decoders'&&state.spectrumPaused&&!force)return;
  const canvas=view.canvas,ctx=view.context;
  if(!spectrumColors){const style=getComputedStyle(document.documentElement);spectrumColors=Object.fromEntries(['bg','grid','grid-soft','label','fill-top','fill-bottom','trace','marker'].map(key=>[key,style.getPropertyValue(`--spectrum-${key}`).trim()]));}
  const colors=spectrumColors;
  fitCanvas(canvas,ctx);const width=canvas.clientWidth,height=canvas.clientHeight;if(!width||!height)return;
  ctx.clearRect(0,0,width,height);ctx.fillStyle=colors.bg;ctx.fillRect(0,0,width,height);
  const left=43,right=12,top=14,bottom=24,plotW=width-left-right,plotH=height-top-bottom;
  ctx.lineWidth=1;ctx.font='9px "DM Mono",Consolas,monospace';ctx.textAlign='right';
  for(let i=0;i<=4;i++){const y=top+i*plotH/4;ctx.strokeStyle=colors.grid;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();ctx.fillStyle=colors.label;ctx.fillText(`${-i*25} dB`,left-8,y+3);}
  for(let i=0;i<=8;i++){const x=left+i*plotW/8;ctx.strokeStyle=colors['grid-soft'];ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+plotH);ctx.stroke();}
  const raw=view.page==='decoders'&&state.spectrumPaused?view.frame:state.spectrum;view.frame=raw;
  const frame=waterfallFrame(view);
  if(!frame?.bins?.length)return;
  const points=frame.bins.map((value,index)=>[left+index/(frame.bins.length-1)*plotW,top+(1-Math.max(0,Math.min(1,(value+100)/100)))*plotH]);
  const fill=ctx.createLinearGradient(0,top,0,top+plotH);fill.addColorStop(0,colors['fill-top']);fill.addColorStop(1,colors['fill-bottom']);
  ctx.beginPath();ctx.moveTo(points[0][0],top+plotH);for(const [x,y] of points)ctx.lineTo(x,y);ctx.lineTo(points.at(-1)[0],top+plotH);ctx.closePath();ctx.fillStyle=fill;ctx.fill();
  ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);for(const [x,y] of points)ctx.lineTo(x,y);ctx.strokeStyle=colors.trace;ctx.lineWidth=1.35;ctx.stroke();
  if(frame.source==='survey'){
    ctx.save();ctx.fillStyle='rgba(125,145,158,.16)';ctx.strokeStyle='rgba(150,170,182,.25)';ctx.font='8px "DM Mono",Consolas,monospace';ctx.textAlign='center';
    for(const [low,high] of surveyUnsupportedRanges(frame)){
      const x1=left+(low-(frame.center-frame.span/2))/frame.span*plotW,x2=left+(high-(frame.center-frame.span/2))/frame.span*plotW;
      ctx.fillRect(x1,top,x2-x1,plotH);ctx.beginPath();ctx.moveTo(x1,top);ctx.lineTo(x1,top+plotH);ctx.moveTo(x2,top);ctx.lineTo(x2,top+plotH);ctx.stroke();
      if(x2-x1>68){ctx.fillStyle='rgba(180,194,202,.72)';ctx.fillText('UNSUPPORTED',(x1+x2)/2,top+12);ctx.fillStyle='rgba(125,145,158,.16)';}
    }
    ctx.restore();
  }
  const marker=left+((frame.tunedFrequency??frame.center)-frame.center+frame.span/2)/frame.span*plotW;
  if(marker>=left&&marker<=left+plotW){ctx.strokeStyle=colors.marker;ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(marker,top);ctx.lineTo(marker,top+plotH);ctx.stroke();ctx.setLineDash([]);}
  updateSpectrumLabels(view,frame);
}
function updateSpectrumLabels(view,frame) {
  $(`#${view.prefix}freq-left`).textContent=formatMHz(frame.center-frame.span/2,3);
  $(`#${view.prefix}freq-mid`).textContent=`${formatMHz(frame.center,3)} MHz`;
  $(`#${view.prefix}freq-right`).textContent=formatMHz(frame.center+frame.span/2,3);
  $(`#${view.prefix}bandwidth-label`).textContent=frame.source==='survey'?'0–2400 MHz panorama · supported bands swept':`${(frame.span/1e6).toFixed(3)} MHz span`;
  if(view.page==='decoders'){
    $('#decoder-rf-source').textContent=frame.source==='survey'?'WIDE RF SURVEY':frame.source==='digital'?'NATIVE DECODER IQ':frame.source==='hd'?'HD RADIO USB IQ':'USB RECEIVER IQ';
    $('#decoder-rf-tuned').textContent=frame.source==='survey'?`Wide survey · ${state.wideSurvey?.progress??frame.surveyProgress??0}% complete`:`${state.spectrumPaused?'Frozen at':'Tuned'} ${formatFrequency(frame.tunedFrequency??frame.center)}`;
  }
}
function surveyUnsupportedRanges(frame) {
  const low=frame.center-frame.span/2,high=frame.center+frame.span/2;
  const ranges=(frame.surveyRanges||state.wideSurvey?.ranges||[]).map(([from,to])=>[Math.max(low,from),Math.min(high,to)]).filter(([from,to])=>to>from).sort((a,b)=>a[0]-b[0]);
  const gaps=[];let cursor=low;
  for(const [from,to] of ranges){if(from>cursor)gaps.push([cursor,from]);cursor=Math.max(cursor,to);}
  if(cursor<high)gaps.push([cursor,high]);
  return gaps;
}
function waterfallFrame(view) {
  const frozen=view.page==='decoders'&&state.spectrumPaused&&view.frame;
  const frame=frozen?view.frame:state.spectrum;
  if(!frame?.bins?.length||!Number.isFinite(frame.center)||!(frame.span>0))return null;
  const survey=Boolean(!frozen&&state.wideSurvey?.running&&frame.source==='survey');
  if(!frozen&&!survey){
    const status=state.status||{},running=Boolean(status.connected||status.hdActive||status.digitalActive&&status.digital?.engine==='integrated');
    const source=status.hdActive?'hd':status.digitalActive?'digital':'usb';
    if(!running||frame.source!==source||Date.now()-Number(frame.receivedAt||0)>2200)return null;
  }
  const zoom=Math.max(1,Math.min(1024,Number(view.zoom)||1));
  if(zoom===1&&frame.bins.length<=1024)return frame;
  const span=frame.span/zoom,frameLow=frame.center-frame.span/2,frameHigh=frame.center+frame.span/2;
  const requestedCenter=Number.isFinite(view.center)?view.center:frame.center;
  const center=Math.max(frameLow+span/2,Math.min(frameHigh-span/2,requestedCenter)),displayLow=center-span/2;
  const count=Math.min(1024,Math.max(2,frame.bins.length)),bins=new Array(count);
  for(let i=0;i<count;i++){
    const frequency=displayLow+i/(count-1)*span,index=(frequency-frameLow)/frame.span*(frame.bins.length-1);
    if(index<0||index>frame.bins.length-1){bins[i]=-120;continue;}
    const lower=Math.floor(index),upper=Math.min(frame.bins.length-1,lower+1),fraction=index-lower;
    bins[i]=frame.bins[lower]*(1-fraction)+frame.bins[upper]*fraction;
  }
  return {...frame,center,span,bins};
}
function waterfallFrequency(view,event) {
  const frame=waterfallFrame(view),rect=view.waterfall.getBoundingClientRect();
  if(!frame||!rect.width)return null;
  const left=43,right=12,x=event.clientX-rect.left,plotWidth=rect.width-left-right;
  if(plotWidth<=0||x<left||x>rect.width-right)return null;
  const fraction=(x-left)/plotWidth;
  return Math.round(frame.center-frame.span/2+fraction*frame.span);
}
function snapWaterfallFrequency(frequency) {
  // Keep click-to-tune precise even when the manual tuning step is 25 kHz or larger.
  const step=1000;
  return Math.round(frequency/step)*step;
}
async function tuneFromWaterfall(view,event) {
  const clickedFrequency=waterfallFrequency(view,event);
  if(!clickedFrequency)return;
  const frequency=snapWaterfallFrequency(clickedFrequency);
  try {
    if(frequency<10000||frequency>1766000000){toast('This frequency is outside the application tuning range.','error');return;}
    const supported=state.wideSurvey?.running?state.wideSurvey.ranges:state.status?.connected?rtlSurveyRanges():null;
    if(supported&&!supported.some(([low,high])=>frequency>=low&&frequency<=high)){
      toast('This part of the panorama is outside the connected RTL-SDR tuner’s supported bands.','error');return;
    }
    if(state.wideSurvey?.running)await stopWideSurvey({restore:false});
    state.status=await api('/api/tune',{frequency});
    setFrequencyDisplay(frequency);
    for(const item of spectrumViews)item.center=null;
    if(view.page==='decoders'&&state.spectrumPaused){
      state.spectrumPaused=false;
      view.frozenHistory=null;view.frozenEpoch='';
      const button=$('#decoder-spectrum-freeze');button.textContent='Freeze';button.setAttribute('aria-pressed','false');
      drawSpectrum(true);drawWaterfall(true);
    }
    renderStatus();
  } catch(error) { toast(error.message,'error'); }
}
function renderSpectrumStatus() {
  const status=state.status||{},running=Boolean(status.connected||status.hdActive||status.digitalActive&&status.digital?.engine==='integrated');
  const survey=Boolean(state.wideSurvey?.running),source=survey?'survey':status.hdActive?'hd':status.digitalActive?'digital':'usb';
  const fresh=survey?state.spectrum?.source==='survey':running&&state.spectrum&&Date.now()-state.spectrum.receivedAt<2200&&state.spectrum.source===source;
  for(const view of spectrumViews){
    view.waterfall.classList.toggle('waterfall-tuneable',Boolean(waterfallFrame(view)));
    const held=view.page==='decoders'&&state.spectrumPaused&&view.frame;
    const overlay=$(`#${view.prefix}spectrum-placeholder`);overlay.classList.toggle('hidden',Boolean(fresh||held));
    overlay.querySelector('strong').textContent=survey?'Surveying receiver frequency range':running?'Waiting for RF samples':status.digitalActive?'External decoder RF feed unavailable':'RF spectrum is standing by';
    overlay.querySelector('span:last-of-type').textContent=survey?`Sequential sweep · ${state.wideSurvey.progress}% complete. Live audio is paused during the sweep.`:running?'The display will update when receiver IQ samples arrive.':'Start the USB receiver, HD Radio, or integrated digital decoder to view incoming RF.';
  }
  $('#placeholder-connect').textContent=status.digitalActive?'Open decoder workstation':'Connect receiver';
  const pill=$('#decoder-rf-live');pill.classList.toggle('paused',state.spectrumPaused);
  pill.innerHTML=`<i></i>${survey?`SWEEP ${state.wideSurvey.progress}%`:state.spectrumPaused?'PAUSED':fresh?'LIVE':running?'WAITING':'IDLE'}`;
  $('#radio-rf-live').innerHTML=`<i></i>${survey?`SWEEP ${state.wideSurvey.progress}%`:fresh?'LIVE':running?'WAITING':'IDLE'}`;
  const canSurvey=Boolean(status.connected&&!status.hdActive&&!status.digitalActive);
  for(const id of ['full-span-button','decoder-full-span-button']){
    const button=$('#'+id);button.textContent=survey?'Stop survey':'Wide survey';button.disabled=!survey&&!canSurvey;
    button.title=survey?'Stop the sequential RF survey':canSurvey?'Sequentially survey the supported RTL-SDR bands across a 0–2.4 GHz panorama. Live audio pauses while scanning.':'Connect live RF reception and stop HD Radio or the digital decoder before starting a wide survey.';
  }
  $('#decoder-spectrum-freeze').disabled=Boolean(survey)||!state.spectrum&&!state.spectrumPaused;
}
function colorForDb(db) {
  const v=Math.max(0,Math.min(1,(db+100)/100));
  if(v<.28){const t=v/.28;return[8+9*t,20+27*t,33+47*t];}
  if(v<.63){const t=(v-.28)/.35;return[17+16*t,47+100*t,80+73*t];}
  const t=(v-.63)/.37;return[33+161*t,147+82*t,153-77*t];
}
function drawWaterfall(rebuild=false) {
  const view=activeSpectrumView();if(!view)return;
  const frozen=view.page==='decoders'&&state.spectrumPaused,display=waterfallFrame(view),base=frozen?view.frame:state.spectrum;
  if(!display||!base?.bins?.length)return;
  const canvas=view.waterfall,ctx=view.waterfallContext;
  const resized=fitCanvas(canvas,ctx);if(!canvas.clientWidth||!canvas.clientHeight)return;
  ctx.setTransform(1,0,0,1,0,0);
  const dpr=Math.min(window.devicePixelRatio||1,2),left=Math.floor(43*dpr),right=Math.floor(12*dpr),width=Math.max(1,canvas.width-left-right);
  const epoch=frozen?(view.frozenEpoch||state.spectrumEpoch):state.spectrumEpoch;
  const history=frozen?(view.frozenHistory||[]):state.rfHistory;
  const timestamp=base.timestamp||0;
  const full=rebuild||resized||view.epoch!==epoch;
  if(full){ctx.fillStyle='#081421';ctx.fillRect(0,0,canvas.width,canvas.height);}
  const rows=full?history.slice(-canvas.height).reverse():history.length?[history.at(-1)]:[];
  if(!full&&view.lastFrame===timestamp)return;
  if(!full)ctx.drawImage(canvas,0,0,canvas.width,Math.max(1,canvas.height-1),0,1,canvas.width,Math.max(1,canvas.height-1));
  if(rows.length){
    const image=ctx.createImageData(canvas.width,rows.length);
    for(let y=0;y<rows.length;y++)for(let x=0;x<width;x++){
      const bins=rows[y],low=base.center-base.span/2,visibleLow=display.center-display.span/2;
      const from=visibleLow+x/width*display.span,to=visibleLow+(x+1)/width*display.span;
      if(display.source==='survey'&&!((display.surveyRanges||[]).some(([rangeLow,rangeHigh])=>(from+to)/2>=rangeLow&&(from+to)/2<=rangeHigh))){
        const p=(y*canvas.width+left+x)*4;image.data[p]=22;image.data[p+1]=34;image.data[p+2]=44;image.data[p+3]=255;continue;
      }
      const start=Math.max(0,Math.floor((from-low)/base.span*(bins.length-1)));
      const end=Math.min(bins.length,Math.max(start+1,Math.ceil((to-low)/base.span*(bins.length-1))));
      let peak=-120;for(let k=start;k<end;k++)peak=Math.max(peak,bins[k]);
      const [r,g,b]=colorForDb(peak),p=(y*canvas.width+left+x)*4;image.data[p]=r;image.data[p+1]=g;image.data[p+2]=b;image.data[p+3]=255;
    }
    ctx.putImageData(image,0,0);
  }
  view.epoch=epoch;view.lastFrame=timestamp;
}
function rtlSurveyRanges() {
  const info=state.status?.rtlInfo||{},type=Number(info.tunerType),product=`${info.manufacturer||''} ${info.product||''}`.toLowerCase();
  const max=1766000000;
  if(Number(state.settings.directSampling))return [[500000,28800000]];
  if(type===1)return [[52000000,max]];
  if(type===2)return [[22000000,948600000]];
  if(type===3)return [[22000000,1100000000]];
  if(type===4)return [[146000000,308000000],[438000000,924000000]];
  if((type===5||type===6)&&/blog.{0,8}v4|v4.{0,8}blog/.test(product))return [[500000,max]];
  return [[24000000,max]];
}
function rtlSurveyCenters(ranges,rate) {
  const half=rate/2,step=Math.max(250000,Math.floor(rate*.8)),centers=[];
  for(const [low,high] of ranges){
    const first=low+half,last=high-half;
    if(first>last){centers.push(Math.round((low+high)/2));continue;}
    for(let center=first;center<=last;center+=step)centers.push(Math.round(center));
    if(!centers.length||centers.at(-1)!==Math.round(last))centers.push(Math.round(last));
  }
  return centers;
}
function publishSurveyFrame(survey,{completed=false}={}) {
  const bins=survey.bins,now=Date.now(),epoch=`survey:${survey.id}:${survey.completedPass}`;
  state.spectrum={type:'spectrum',source:'survey',bins,center:survey.center,tunedFrequency:survey.returnFrequency,span:survey.span,
    timestamp:now,receivedAt:now,epoch,surveyProgress:survey.progress,surveyRanges:survey.ranges};
  if(completed){
    state.rfHistory.push(Float32Array.from(bins));if(state.rfHistory.length>24)state.rfHistory.shift();
    state.spectrumEpoch=epoch;drawWaterfall(true);
  }
  drawSpectrum(true);renderSpectrumStatus();
}
async function startWideSurvey() {
  if(state.wideSurvey?.running)return;
  if(state.status?.hdActive||state.status?.digitalActive){toast('Stop HD Radio or the digital decoder before starting a wide survey.','error');return;}
  if(!isConnected()){toast('Start live RF reception before beginning a wide survey.','error');return;}
  if(state.status?.scannerActive)state.status=await api('/api/scan/stop',{keepReceiver:true});
  const ranges=rtlSurveyRanges(),rate=Number(state.status.sampleRate||state.settings.sampleRate||2400000),centers=rtlSurveyCenters(ranges,rate);
  if(!centers.length){toast('No supported tuning range was found for this RTL-SDR.','error');return;}
  const low=0,high=2400000000,id=++state.spectrumGeneration;
  const survey={id,running:true,ranges,centers,rate,low,high,center:(low+high)/2,span:high-low,returnFrequency:Number(state.status.frequency||100000000),progress:0,completedPass:0,bins:new Float32Array(262144),pendingTune:null};
  survey.bins.fill(-120);state.wideSurvey=survey;state.spectrumPaused=false;
  const freeze=$('#decoder-spectrum-freeze');freeze.textContent='Freeze';freeze.setAttribute('aria-pressed','false');
  for(const view of spectrumViews){view.zoom=1;view.center=null;view.frozenHistory=null;view.frozenEpoch='';}
  state.rfHistory=[];state.spectrumEpoch=`survey:${id}:0`;audioQueue.clear();drawWaterfall(true);
  publishSurveyFrame(survey);void runWideSurvey(survey);
}
async function runWideSurvey(survey) {
  const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  try{
    while(survey.running&&state.wideSurvey===survey){
      survey.bins=new Float32Array(262144);survey.bins.fill(-120);survey.progress=0;
      for(let index=0;index<survey.centers.length;index++){
        if(!survey.running||state.wideSurvey!==survey)break;
        const center=survey.centers[index],previous=state.lastLiveSpectrum?.receivedAt||0;
        const tuning=api('/api/tune',{frequency:center});survey.pendingTune=tuning;
        try{state.status=await tuning;}finally{if(survey.pendingTune===tuning)survey.pendingTune=null;}
        const deadline=Date.now()+1600;let frame=null;
        while(survey.running&&Date.now()<deadline){
          const candidate=state.lastLiveSpectrum;
          if(candidate?.source==='usb'&&candidate.center===center&&candidate.receivedAt>previous){frame=candidate;break;}
          await wait(12);
        }
        if(!survey.running||state.wideSurvey!==survey)break;
        if(!frame)throw new Error(`No RF spectrum frame arrived at ${formatFrequency(center)}.`);
        const bins=frame.bins,binWidth=frame.span/(bins.length-1);
        for(let i=0;i<bins.length;i++){
          const frequency=frame.center-frame.span/2+i*binWidth;
          if(!survey.ranges.some(([from,to])=>frequency>=from&&frequency<=to))continue;
          const target=Math.floor((frequency-survey.low)/survey.span*(survey.bins.length-1));
          if(target>=0&&target<survey.bins.length&&bins[i]>survey.bins[target])survey.bins[target]=bins[i];
        }
        survey.progress=Math.floor((index+1)/survey.centers.length*100);
        if(index%8===0||index===survey.centers.length-1)publishSurveyFrame(survey);
      }
      if(!survey.running||state.wideSurvey!==survey)break;
      survey.completedPass++;
      publishSurveyFrame(survey,{completed:true});
    }
  }catch(error){
    if(state.wideSurvey===survey&&survey.running){toast(`Wide survey stopped: ${error.message}`,'error');await stopWideSurvey({restore:true});}
  }
}
async function stopWideSurvey({restore=true}={}) {
  const survey=state.wideSurvey;if(!survey)return;
  survey.running=false;
  await survey.pendingTune?.catch(()=>{});
  state.wideSurvey=null;state.spectrum=null;state.lastLiveSpectrum=null;state.rfHistory=[];state.spectrumEpoch='';audioQueue.clear();
  if(restore&&isConnected()){
    try{state.status=await api('/api/tune',{frequency:survey.returnFrequency});setFrequencyDisplay(survey.returnFrequency);}
    catch(error){toast(error.message,'error');}
  }
  for(const view of spectrumViews){view.lastFrame=0;view.zoom=1;view.center=null;view.frozenHistory=null;view.frozenEpoch='';}
  drawSpectrum(true);drawWaterfall(true);renderSpectrumStatus();renderStatus();
}
async function toggleWideSurvey() {
  try{
    if(state.wideSurvey?.running)await stopWideSurvey({restore:true});
    else await startWideSurvey();
  }catch(error){toast(error.message,'error');}
}
function zoomSpectrum(view,direction,event) {
  const frame=waterfallFrame(view);if(!frame)return;
  let anchor=null,fraction=.5;
  if(event){
    const rect=view.waterfall.getBoundingClientRect(),plotWidth=rect.width-55;
    if(plotWidth>0){fraction=Math.max(0,Math.min(1,(event.clientX-rect.left-43)/plotWidth));anchor=frame.center-frame.span/2+fraction*frame.span;}
  }
  const previous=view.zoom||1,next=Math.max(1,Math.min(1024,previous*(direction>0?2:.5)));
  if(next===previous)return;
  view.zoom=next;
  if(next===1)view.center=null;
  else view.center=(anchor??frame.center)+(0.5-fraction)*frame.span*previous/next;
  drawSpectrum(true);drawWaterfall(true);renderSpectrumStatus();
}
function addFt8Decode(decode) {
  state.propagation?.decode(decode);
  const body=$('#ft8-decodes');if(body.querySelector('.decode-empty'))body.replaceChildren();
  const tr=document.createElement('tr');
  tr.innerHTML=`<td>${escapeHtml(decode.time||'--:--:--')}</td><td>${escapeHtml(decode.snr)}</td><td>${escapeHtml(decode.hz)}</td><td>${escapeHtml(decode.mode)}</td><td>${escapeHtml(decode.message)}${decode.lowConfidence?' · low confidence':''}</td>`;body.prepend(tr);while(body.children.length>35)body.lastElementChild.remove();
}
async function startFt8() {
  try{const result=await api('/api/wsjt/start',{port:Number(state.settings.wsjtPort||2237)});state.ft8=true;$('#ft8-dot').classList.add('active');$('#ft8-state').textContent='Listening for WSJT-X';$('#ft8-toggle').textContent='Stop bridge';$('#ft8-port').textContent=`UDP 127.0.0.1:${result.port}`;toast('FT8 decoder bridge listening on UDP.','success');}
  catch(error){toast(error.message,'error');}
}
async function stopFt8() { try{await fetch('/api/wsjt/stop',{method:'POST'});state.ft8=false;$('#ft8-dot').classList.remove('active');$('#ft8-state').textContent='Bridge not started';$('#ft8-toggle').textContent='Start bridge';}catch{} }
async function saveSettings({silent=false} = {}) {
  const select=$('#usb-device'),device=state.usbDevices.find(item=>item.index===Number(select.value));
  const settings={rtlLibraryPath:$('#rtl-library-path').value.trim(),deviceIndex:device?.index??state.settings.deviceIndex??0,deviceSerial:device?.serial??state.settings.deviceSerial??'',
    ppm:Number($('#usb-ppm').value),directSampling:Number($('#usb-sampling').value),tunerBandwidth:Number($('#usb-bandwidth').value),rtlAgc:$('#usb-agc').checked,biasTee:$('#usb-bias').checked,
    tunerGain:$('#usb-tuner-auto').checked?0:Math.round(Number($('#usb-gain').value)*10),
    digitalEngine:$('#digital-engine').value,dsdPath:$('#dsd-path').value.trim(),sampleRate:Number($('#sample-rate').value),wsjtPort:Number(state.settings.wsjtPort||2237),audioOutputId:$('#audio-output').value};
  try{
    state.settings=await api('/api/settings',settings);
    if(isConnected()||isDigitalActive()){const result=await api('/api/gain',{gain:settings.tunerGain});state.status=result;renderStatus();}
    $('#external-decoder-fields').classList.toggle('hidden',settings.digitalEngine!=='external');renderDigital();
    if(!silent)toast('USB hardware settings saved. Reconnect to apply sampling changes.','success');
    $('#sample-rate-label').textContent=`${(settings.sampleRate/1e6).toFixed(1)} MSPS`;return true;
  } catch(error){toast(error.message,'error');return false;}
}

async function refreshUsbDevices() {
  const refresh=$('#usb-refresh');if(refresh.disabled)return;refresh.disabled=true;
  const message=$('#usb-discovery-status');message.className='usb-discovery-status';message.textContent='Discovering attached USB receivers…';
  try {
    const data=await api('/api/rtl/devices');state.usbDevices=data.devices||[];
    const select=$('#usb-device');select.replaceChildren();
    for(const device of state.usbDevices)select.append(new Option(`${device.product||device.name} · #${device.index} · ${device.serial||'no serial'}`,String(device.index)));
    if(!state.usbDevices.length)select.append(new Option('No RTL-SDR USB device detected',''));
    const saved=state.usbDevices.find(device=>device.serial&&device.serial===state.settings.deviceSerial)||state.usbDevices.find(device=>device.index===Number(state.settings.deviceIndex));
    if(saved)select.value=String(saved.index);
    message.classList.toggle('ready',data.available&&state.usbDevices.length>0);message.classList.toggle('error',!data.available);
    message.textContent=!data.available?data.error:state.usbDevices.length?`${state.usbDevices.length} RTL-SDR USB receiver${state.usbDevices.length===1?'':'s'} detected · native library ready`:state.platform==='linux'?'Native library ready. Plug in your RTL-SDR and use Refresh. If no device appears, check USB permissions.':state.platform==='darwin'?'Native library ready. Plug in your RTL-SDR and use Refresh. Close other SDR applications if the dongle is claimed.':'Native library ready. Plug in your RTL-SDR and use Refresh. If needed, install WinUSB for Interface 0.';
    $('#usb-library-info').textContent=data.libraryPath?`Loaded library: ${data.libraryPath}`:'No native RTL-SDR library loaded.';
    renderUsbDevice();
  }catch(error){message.classList.add('error');message.textContent=error.message;}
  finally{refresh.disabled=false;}
}
function renderUsbDevice() {
  const device=state.usbDevices.find(item=>item.index===Number($('#usb-device').value));
  $('#usb-device-details').textContent=device?`${device.manufacturer||'RTL-SDR'} · ${device.product||device.name} · USB serial ${device.serial||'not reported'}`:'';
}
async function refreshAudioOutputs() {
  const select=$('#audio-output'),selected=state.settings.audioOutputId||select.value;
  try{
    const devices=await navigator.mediaDevices?.enumerateDevices?.();if(!devices)return;
    select.replaceChildren(new Option('System default',''));
    for(const device of devices.filter(item=>item.kind==='audiooutput')){const option=new Option(device.label||`Audio output ${select.length}`,device.deviceId);select.append(option);}
    if([...select.options].some(option=>option.value===selected))select.value=selected;
  }catch{}
}
async function chooseAudioOutput() {
  if(!navigator.mediaDevices?.selectAudioOutput){toast('This desktop runtime cannot select a separate audio output. Choose the system default output device instead.');return;}
  try{const device=await navigator.mediaDevices.selectAudioOutput();if(device?.deviceId){await refreshAudioOutputs();$('#audio-output').value=device.deviceId;await applyAudioOutput(device.deviceId);await saveSettings();}}
  catch(error){if(error.name!=='NotAllowedError')toast(error.message||'Could not select an audio output.','error');}
}
async function applyAudioOutput(deviceId) {
  if(!audioContext)return;
  if(typeof audioContext.setSinkId!=='function'){if(deviceId)toast('This browser does not support audio output selection.');return;}
  try{await audioContext.setSinkId(deviceId||'');}catch(error){toast(`Audio output could not be changed: ${error.message}`,'error');}
}
function createStarterChannels() {
  return [
    {name:'2 m Calling',frequency:146520000,mode:'NFM',group:'Amateur',notes:'2 m simplex calling frequency',kind:'conventional',source:'Starter'},
    {name:'NOAA Weather',frequency:162550000,mode:'NFM',group:'Weather',notes:'Local NOAA weather broadcast',kind:'conventional',source:'Starter'},
    {name:'20 m FT8',frequency:14074000,mode:'USB',group:'Amateur',notes:'Common 20 m FT8 dial frequency',kind:'conventional',source:'Starter'},
    {name:'Airband Guard',frequency:121500000,mode:'AM',group:'Aviation',notes:'Aeronautical emergency frequency',kind:'conventional',source:'Starter'}
  ];
}
async function refreshState() {
  const data=await api('/api/state');state.platform=data.platform||window.sdrDesktop?.platform||'unknown';state.status=data.status;state.channels=data.channels||[];state.settings=data.settings||{};state.digitalRuntime=data.digitalRuntime;state.digitalEvents=data.digitalHistory||[];state.hdRuntime=data.hdRuntime;
  if(data.status.digitalActive&&data.status.selectedChannelId){const current=state.channels.find(channel=>channel.id===data.status.selectedChannelId);state.selectedTrunkId=current?.kind==='trunked'?current.id:'';state.decoderMemoryId=current?.kind!=='trunked'?current?.id||'':'';}
  if(!state.scanSelectionLoaded){state.scanSelection=new Set(state.settings.scanChannelIds||[]);state.scanSelectionLoaded=true;}
  state.scanSelection=new Set([...state.scanSelection].filter(id=>state.channels.some(channel=>channel.id===id&&(channel.kind==='trunked'||(channel.mode!=='HD'&&channel.enabled!==false)))));
  $('#rtl-library-path').value=state.settings.rtlLibraryPath||'';$('#dsd-path').value=state.settings.dsdPath||'';$('#sample-rate').value=String(state.settings.sampleRate||2400000);
  const linux=state.platform==='linux',mac=state.platform==='darwin';
  $('#rtl-hardware-help').textContent=linux?'Uses the app’s pinned Blog V4-compatible driver for RTL-SDR V1–V4. Configure USB access permissions for your user account.':mac?'Uses the app’s bundled V1–V4-compatible RTL-SDR driver. Connect the dongle directly and close any other SDR app that may own it.':'Connect directly to your dongle through the native RTL-SDR library. Choose a device below and start listening.';
  $('#rtl-library-label').textContent='CUSTOM RTL-SDR LIBRARY (OPTIONAL)';
  $('#rtl-library-path').placeholder=linux?'Bundled V1–V4 driver · custom .so override optional':mac?'Bundled V1–V4 driver · custom .dylib override optional':'Bundled Blog V4-compatible x64 rtlsdr.dll';
  $('#rtl-permissions-help').textContent=linux?'Linux setup: configure USB device permissions as described in the README. The release includes the native RTL-SDR driver. Do not run the desktop app as root.':mac?'macOS uses the bundled native driver. If the dongle is not detected, quit other SDR applications and reconnect it.':'Windows setup: install WinUSB for the dongle’s Bulk-In Interface 0.';
  $('#rtl-setup-link').classList.toggle('hidden',linux||mac);
  if(linux||mac){$('#digital-engine').options[0].textContent='Integrated DSD-neo';$('#dsd-path').placeholder=mac?'/opt/homebrew/bin/dsd-neo':'/usr/bin/dsd-fme';}
  $('#digital-engine').value=state.settings.digitalEngine||'integrated';$('#external-decoder-fields').classList.toggle('hidden',$('#digital-engine').value!=='external');
  $('#usb-ppm').value=state.settings.ppm||0;$('#usb-sampling').value=String(state.settings.directSampling||0);$('#usb-bandwidth').value=String(state.settings.tunerBandwidth||0);
  $('#usb-agc').checked=Boolean(state.settings.rtlAgc);$('#usb-bias').checked=Boolean(state.settings.biasTee);$('#usb-tuner-auto').checked=!state.settings.tunerGain;
  $('#usb-gain').value=state.settings.tunerGain?state.settings.tunerGain/10:19.7;$('#usb-gain').disabled=$('#usb-tuner-auto').checked;
  renderStatus();renderChannels();renderDigitalEvents();
  if(data.status.wsjtActive){state.ft8=true;$('#ft8-dot').classList.add('active');$('#ft8-state').textContent='Listening for WSJT-X';$('#ft8-toggle').textContent='Stop bridge';}
}
function bindEvents() {
  document.addEventListener('signal-outpost:themechange',()=>{spectrumColors=null;drawSpectrum(true);});
  for(const view of spectrumViews){
    view.waterfall.title='Click a signal to tune to its frequency';
    view.waterfall.addEventListener('pointermove',event=>{
      const frequency=waterfallFrequency(view,event);
      const snapped=frequency?snapWaterfallFrequency(frequency):null;
      view.waterfall.title=snapped?`Click to tune to ${formatFrequency(snapped)} (1 kHz resolution)`:'Click a signal to tune to its frequency';
    });
    view.waterfall.addEventListener('pointerleave',()=>{view.waterfall.title='Click a signal to tune to its frequency';});
    view.waterfall.addEventListener('click',event=>{void tuneFromWaterfall(view,event);});
    view.waterfall.addEventListener('wheel',event=>{
      if(!waterfallFrame(view))return;
      event.preventDefault();
      zoomSpectrum(view,event.deltaY<0?1:-1,event);
    },{passive:false});
  }
  $$('.app-dialog button[value="cancel"]').forEach(button=>{button.type='button';button.addEventListener('click',()=>button.closest('dialog').close('cancel'));});
  for(const id of ['channel-kind','channel-mode','channel-p25-phase'])$('#'+id).addEventListener('change',updateChannelProtocolFields);
  $('#scan-select-visible').addEventListener('click',()=>{const selectedTrunked=state.channels.some(channel=>state.scanSelection.has(channel.id)&&channel.kind==='trunked');const trunked=selectedTrunked||(!state.scanSelection.size&&$('#channel-filter').value==='trunked');$$('[data-scan-id]:not(:disabled)').forEach(input=>{const channel=state.channels.find(item=>item.id===input.dataset.scanId);if(channel&&(channel.kind==='trunked')===trunked)state.scanSelection.add(channel.id);});renderChannelRows();});
  $('#scan-clear-selection').addEventListener('click',()=>{state.scanSelection.clear();renderChannelRows();});
  $('#scan-selected').addEventListener('click',startSelectedScan);
  $('#scan-stop').addEventListener('click',async()=>{try{state.status=await api('/api/scan/stop',{});await stopAudio();renderStatus();toast('Scan and live RF stopped.');}catch(error){toast(error.message,'error');}});
  $('#scan-skip').addEventListener('click',async()=>{try{state.status=await api('/api/scan/skip',{});renderStatus();}catch(error){toast(error.message,'error');}});
  $$('[data-page]').forEach(button=>button.addEventListener('click',()=>setPage(button.dataset.page)));
  $$('[data-goto]').forEach(button=>button.addEventListener('click',()=>setPage(button.dataset.goto)));
  $('#frequency-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();tuneFromInput();}});$('#frequency-input').addEventListener('blur',()=>{const n=Number($('#frequency-input').value);if(n>0)$('#frequency-input').value=n.toFixed(6);});
  $('#freq-up').addEventListener('click',()=>{const freq=Number($('#frequency-input').value)*1e6+state.currentStep;setFrequencyDisplay(freq);tuneFromInput();});$('#freq-down').addEventListener('click',()=>{const freq=Number($('#frequency-input').value)*1e6-state.currentStep;setFrequencyDisplay(freq);tuneFromInput();});
  $('#step-select').addEventListener('click',()=>$('#step-menu').classList.toggle('hidden'));$$('#step-menu button').forEach(button=>button.addEventListener('click',()=>{state.currentStep=Number(button.dataset.step);$('#step-select').innerHTML=`${state.currentStep>=1000?`${state.currentStep/1000} kHz`:`${state.currentStep} Hz`} <span>⌄</span>`;$('#step-menu').classList.add('hidden');}));
  document.addEventListener('click',event=>{if(!event.target.closest('.step-select'))$('#step-menu').classList.add('hidden');});
  $('#mode-select').addEventListener('change',event=>changeMode(event.target.value));$('#connect-button').addEventListener('click',startListening);$('#placeholder-connect').addEventListener('click',()=>isDigitalActive()?setPage('decoders'):startListening());$('#scan-button').addEventListener('click',toggleScan);
  $('#volume-slider').addEventListener('input',event=>{state.volume=Number(event.target.value)/100;$('#volume-value').textContent=event.target.value;if(audioGain&&!state.muted)audioGain.gain.value=state.volume;});$('#mute-button').addEventListener('click',()=>{state.muted=!state.muted;$('#mute-button').textContent=state.muted?'◖̸':'◖';if(audioGain)audioGain.gain.value=state.muted?0:state.volume;});
  $('#quick-add').addEventListener('click',()=>openChannelDialog());$('#add-channel-bottom').addEventListener('click',()=>openChannelDialog());$('#add-channel-button').addEventListener('click',()=>openChannelDialog());$('#empty-add').addEventListener('click',()=>openChannelDialog());$('#channel-form').addEventListener('submit',saveChannel);
  $('#import-rr-button').addEventListener('click',openRadioReferenceDialog);$('#rr-form').addEventListener('submit',importRR);$('#channel-search').addEventListener('input',renderChannelRows);$('#channel-filter').addEventListener('change',renderChannelRows);$('#export-channels').addEventListener('click',exportChannels);$('#import-file').addEventListener('change',event=>{const file=event.target.files?.[0];if(file)importChannelsFile(file);event.target.value='';});
  $('#usb-refresh').addEventListener('click',refreshUsbDevices);$('#usb-device').addEventListener('change',renderUsbDevice);
  $('#usb-tuner-auto').addEventListener('change',()=>{$('#usb-gain').disabled=$('#usb-tuner-auto').checked;});
  $('#browse-rtl-library').classList.toggle('hidden',!window.sdrDesktop);
  $('#browse-rtl-library').addEventListener('click',async()=>{const file=await window.sdrDesktop?.selectRtlLibrary();if(file){$('#rtl-library-path').value=file;if(await saveSettings({silent:true}))refreshUsbDevices();}});
  $('#ft8-toggle').addEventListener('click',()=>state.ft8?stopFt8():startFt8());
  $('#digital-system').addEventListener('change',event=>{state.selectedTrunkId=event.target.value;renderDigitalSystems();});
  $('#digital-site').addEventListener('change',renderDigital);
  $('#rr-import-kind').addEventListener('change',event=>{const conventional=event.target.value==='conventional';$('#rr-system-field').classList.toggle('hidden',conventional);$('#rr-zip-field').classList.toggle('hidden',!conventional);$('#rr-system-id').required=!conventional;$('#rr-system-id').disabled=conventional;$('#rr-zip').required=conventional;$('#rr-zip').disabled=!conventional;$('#rr-submit').textContent=conventional?'Import frequencies':'Import system';});
  $('#digital-toggle').addEventListener('click',()=>toggleDigital());
  $('#digital-clear-events').addEventListener('click',()=>{state.digitalEvents=[];renderDigitalEvents();});
  $('#digital-engine').addEventListener('change',event=>$('#external-decoder-fields').classList.toggle('hidden',event.target.value!=='external'));
  $('#digital-slot').addEventListener('change',async event=>{try{await api('/api/digital/control',{action:'slot',value:Number(event.target.value)});}catch(error){toast(error.message,'error');}});
  $('#digital-return-cc').addEventListener('click',async()=>{try{await api('/api/digital/control',{action:'return-control'});}catch(error){toast(error.message,'error');}});
  $('#digital-scan').addEventListener('change',renderDigital);
  $('#digital-frequency-input').addEventListener('input',()=>{state.decoderMemoryId='';});
  $('#save-current-memory').addEventListener('click',()=>saveCurrentMemory('radio'));
  $('#digital-add-memory').addEventListener('click',()=>saveCurrentMemory('decoders'));
  $('#digital-add-memory').title='Save the currently tuned channel. Freeze pauses only the RF display.';
  $('#decoder-spectrum-freeze').addEventListener('click',()=>{
    state.spectrumPaused=!state.spectrumPaused;const button=$('#decoder-spectrum-freeze');button.textContent=state.spectrumPaused?'Resume':'Freeze';button.setAttribute('aria-pressed',String(state.spectrumPaused));
    const view=spectrumViews.find(item=>item.page==='decoders');
    if(!state.spectrumPaused){view.frozenHistory=null;view.frozenEpoch='';drawSpectrum();drawWaterfall(true);}
    else{view.frozenHistory=state.rfHistory.slice();view.frozenEpoch=state.spectrumEpoch;if(view.frame)updateSpectrumLabels(view,view.frame);}
    renderSpectrumStatus();
  });
  $('#decoder-waterfall-clear').addEventListener('click',()=>{
    state.rfHistory=[];
    for(const view of spectrumViews){view.waterfallContext.setTransform(1,0,0,1,0,0);view.waterfallContext.clearRect(0,0,view.waterfall.width,view.waterfall.height);view.epoch='';view.lastFrame=0;}
    drawWaterfall(true);
  });
  $('#save-settings').addEventListener('click',saveSettings);$('#save-dsd').addEventListener('click',saveSettings);$('#audio-output').addEventListener('change',async event=>{await applyAudioOutput(event.target.value);await saveSettings();});$('#choose-audio').addEventListener('click',chooseAudioOutput);$('#clear-log').addEventListener('click',()=>{state.activity=[];renderActivity();});$('#clear-cw').addEventListener('click',()=>{state.cwText='';$('#cw-transcript').textContent='Your decoded text will appear here…';});
  $$('.text-button[data-mode]').forEach(button=>button.addEventListener('click',()=>{setPage('radio');$('#mode-select').value=button.dataset.mode;changeMode(button.dataset.mode);}));
  $('#help-button').addEventListener('click',()=>$('#help-dialog').showModal());
  $('#spectrum-zoom-out').addEventListener('click',()=>zoomSpectrum(spectrumViews.find(view=>view.page==='radio'),-1));
  $('#spectrum-zoom-in').addEventListener('click',()=>zoomSpectrum(spectrumViews.find(view=>view.page==='radio'),1));
  $('#decoder-spectrum-zoom-out').addEventListener('click',()=>zoomSpectrum(spectrumViews.find(view=>view.page==='decoders'),-1));
  $('#decoder-spectrum-zoom-in').addEventListener('click',()=>zoomSpectrum(spectrumViews.find(view=>view.page==='decoders'),1));
  $('#full-span-button').addEventListener('click',()=>void toggleWideSurvey());
  $('#decoder-full-span-button').addEventListener('click',()=>void toggleWideSurvey());
  $('#spectrum-expand').addEventListener('click',()=>$('#spectrum-wrap').classList.toggle('expanded'));
}
let desktopUpdateStatus;
function renderDesktopUpdate(status) {
  desktopUpdateStatus = status;
  const banner = $('#desktop-update'), heading = $('#desktop-update-heading'), detail = $('#desktop-update-detail'), action = $('#desktop-update-action');
  banner.classList.toggle('hidden', !['checking', 'downloading', 'ready', 'error', 'installing'].includes(status.phase));
  banner.classList.toggle('update-error', status.phase === 'error');
  action.disabled = ['checking', 'downloading', 'installing'].includes(status.phase);
  action.textContent = status.phase === 'ready' ? 'Restart and install' : status.phase === 'installing' ? 'Restarting…' : 'Check again';
  action.title = '';
  if (status.phase === 'checking') {
    heading.textContent = 'Checking for updates…';
    detail.textContent = `Installed version ${status.version}. You can keep using Signal Outpost.`;
  } else if (status.phase === 'downloading') {
    heading.textContent = `Downloading Signal Outpost ${status.availableVersion} · ${Math.floor(status.percent || 0)}%`;
    detail.textContent = 'A restart button will appear when the download is ready.';
  } else if (status.phase === 'ready') {
    heading.textContent = `Signal Outpost ${status.availableVersion} is ready to install`;
    detail.textContent = `You’re running ${status.version}. Restart now or close normally to install. Memories and settings are preserved.`;
  } else if (status.phase === 'installing') {
    heading.textContent = 'Installing update…';
    detail.textContent = 'The receiver is stopping. Signal Outpost will reopen after installation.';
  } else if (status.phase === 'error') {
    heading.textContent = 'Signal Outpost could not update';
    const retry = status.nextCheckAt ? ` Retrying at ${new Date(status.nextCheckAt).toLocaleTimeString()}.` : ' The app will retry automatically.';
    detail.textContent = status.canInstall ? `Version ${status.availableVersion} could not install. Retry installation or run the latest setup from GitHub Releases. Memories and settings are preserved.` : `Installed version ${status.version}.${retry} Use Help → Check for updates for error details.`;
    action.textContent = status.canInstall ? 'Retry installation' : 'Check again';
    action.title = String(status.error || '').slice(0, 500);
  }
}
async function init() {
  state.meshcore = new MeshCoreUi({api,toast,socketReady:()=>state.socket?.readyState === WebSocket.OPEN});
  state.propagation = new PropagationUi({api,toast,getState:()=>state,refreshState});
  state.hdUi=new HdRadioUi({api,getState:()=>state,updateStatus:next=>{state.status=next;renderStatus();},audio:async()=>{connectSocket();await setupAudio();},saveSettings,memory:draft=>openChannelDialog(draft,{draft:true}),toast});
  bindEvents();updateClock();setInterval(updateClock,1000);setInterval(renderSpectrumStatus,500);window.addEventListener('resize',()=>{drawSpectrum();drawWaterfall(true);});
  setInterval(renderPlaybackDiagnostics,1000);
  window.sdrDesktop?.onNavigate(page=>setPage(page));
  if (window.sdrDesktop?.getUpdateStatus) {
    window.sdrDesktop.onUpdateStatus(renderDesktopUpdate);
    window.sdrDesktop.getUpdateStatus().then(renderDesktopUpdate).catch(error => toast(error.message, 'error'));
    $('#desktop-update-action').addEventListener('click', async () => {
      try {
        if (desktopUpdateStatus?.canInstall) await window.sdrDesktop.installUpdate();
        else await window.sdrDesktop.checkForUpdates();
      } catch (error) { toast(`Update failed: ${error.message}`, 'error'); }
    });
    window.addEventListener('online', () => { if (desktopUpdateStatus?.phase === 'error') window.sdrDesktop.checkForUpdates().catch(() => {}); });
  }
  try {
    await refreshState();
    state.network=new KiwiNetwork({api,toast,settings:()=>state.settings,onSaved:next=>{state.settings={...state.settings,...next};}});
    refreshUsbDevices();
    await refreshAudioOutputs();
    if(!state.channels.length){for(const channel of createStarterChannels())await api('/api/channels',channel);await refreshState();}
    connectSocket();
  }catch(error){toast(`Local receiver service unavailable: ${error.message}`,'error');}
}
init();
