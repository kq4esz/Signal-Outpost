import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.argv[2];
if (!['x64', 'arm64'].includes(arch)) throw new Error('Specify the native macOS architecture: x64 or arm64.');
function read(relative) { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); }
function write(relative, value) { fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`); }
function sha256(relative) { return createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex'); }

const key = `darwin-${arch}`;
const hdRelative = `native/hd-radio/${key}/lib/libnrsc5.dylib`;
const dsdRelative = `native/digital/${key}/bin/dsd-neo`;
for (const relative of [hdRelative, dsdRelative, `native/digital/${key}/lib/librtlsdr-app.dylib`]) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Build the macOS runtime before recording its manifest: ${relative}`);
}
const hd = read('native/hd-radio/manifest.json');
const dsd = read('native/digital/manifest.json');
hd.runtimes[key] = { library: `${key}/lib/libnrsc5.dylib`, sha256: sha256(hdRelative), libraryDirectory: `${key}/lib` };
dsd.runtimes[key] = { executable: `${key}/bin/dsd-neo`, sha256: sha256(dsdRelative), libraryDirectory: `${key}/lib` };
write('native/hd-radio/manifest.json', hd);
write('native/digital/manifest.json', dsd);
