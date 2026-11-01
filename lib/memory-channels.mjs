import { RECEIVER_MODES, DIGITAL_MODES, digitalOptions } from './channel-protocols.mjs';
import { hdMemoryOptions } from './hd-options.mjs';

export function memoryFrequency(value) {
  const frequency = Number(value);
  if (!Number.isFinite(frequency) || frequency < 10000 || frequency > 1766000000) throw new Error('Enter a frequency between 10 kHz and 1.766 GHz.');
  return Math.round(frequency);
}

function normalizeTalkgroupIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Talkgroup IDs must be a list of decimal IDs.');
  const ids = [];
  for (const item of value) {
    const id = String(item).trim();
    if (!/^\d{1,8}$/.test(id) || Number(id) > 16777215) throw new Error('Talkgroup IDs must be decimal numbers from 0 to 16777215.');
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > 1024) throw new Error('Choose up to 1024 talkgroups per memory.');
  return ids;
}

export function normalizeMemory(value, createId = true) {
  const frequency = memoryFrequency(value.frequency);
  const mode = String(value.mode || 'NFM').toUpperCase();
  if (!RECEIVER_MODES.has(mode)) throw new Error('Choose a supported demodulation mode.');
  const kind = value.kind === 'trunked' ? 'trunked' : 'conventional';
  if (kind === 'trunked' && !DIGITAL_MODES.has(mode)) throw new Error('Choose a digital protocol for a trunked system.');
  const name = String(value.name || '').trim().slice(0, 80);
  if (!name) throw new Error('Give this memory channel a name.');
  const channel = { id: createId ? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : value.id,
    name, frequency, mode, kind, group: String(value.group || 'General').trim().slice(0, 50), notes: String(value.notes || '').slice(0, 300), enabled: value.enabled !== false,
    source: String(value.source || 'Manual').slice(0, 60), ...(DIGITAL_MODES.has(mode) ? digitalOptions(value) : {}), ...(mode === 'HD' ? hdMemoryOptions(value) : {}) };
  if (kind === 'trunked') {
    const sites = Array.isArray(value.sites) && value.sites.length ? value.sites : [{ id: 'main', name: 'Main site', frequencies: [{ frequency, use: 'd', lcn: null }] }];
    if (sites.length > 500) throw new Error('Limit each system to 500 sites.');
    channel.sites = sites.map((site, index) => ({ ...site,
      id: String(site.id || `site-${index + 1}`).replace(/[^a-z0-9_-]/gi, '-').slice(0, 80), name: String(site.name || `Site ${index + 1}`).slice(0, 100),
      frequencies: (Array.isArray(site.frequencies) && site.frequencies.length ? site.frequencies : [{ frequency, use: 'd', lcn: null }]).slice(0, 256).map(item => {
        const lcn = item.lcn === '' || item.lcn === null || item.lcn === undefined ? null : Number(item.lcn);
        if (lcn !== null && (!Number.isInteger(lcn) || lcn < 0 || lcn > 65535)) throw new Error('Site LCN must be between 0 and 65535.');
        return { ...item, lcn, frequency: memoryFrequency(item.frequency), use: ['d', 'a'].includes(item.use) ? item.use : '' };
      })
    }));
    channel.talkgroups = Array.isArray(value.talkgroups) ? value.talkgroups : [];
    channel.talkgroupFilterEnabled = value.talkgroupFilterEnabled === true;
    channel.talkgroupIds = normalizeTalkgroupIds(value.talkgroupIds);
    if (channel.talkgroupFilterEnabled && !channel.talkgroupIds.length) throw new Error('Select or enter at least one talkgroup, or turn off the talkgroup filter.');
    channel.systemId = value.systemId || ''; channel.systemCode = value.systemCode || '';
  }
  return channel;
}
