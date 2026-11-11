import { parentPort, workerData } from 'node:worker_threads';
import { BroadcastFm } from './broadcast-fm.mjs';

let fm = new BroadcastFm(workerData?.rate || 1488375);
parentPort.on('message', message => {
  if (Number.isFinite(message.rate)) { fm = new BroadcastFm(message.rate); return; }
  const iq = new Uint8Array(message.iq);
  const samples = fm.push(iq);
  parentPort.postMessage({ samples: samples.buffer, length: samples.length, consumed: iq.byteLength, generation: message.generation }, [samples.buffer]);
});
