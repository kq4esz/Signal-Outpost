import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = 'native/digital/win32-x64/bin/dsd-neo.exe';
const manifestPath = path.join(root, 'native/digital/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const executablePath = path.join(root, executable);
if (!fs.existsSync(executablePath)) {
  throw new Error(`Build the Windows DSD-neo runtime before recording its manifest: ${executable}`);
}
manifest.runtimes['win32-x64'] = {
  executable: 'win32-x64/bin/dsd-neo.exe',
  sha256: createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex'),
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Recorded Windows DSD-neo executable hash: ${manifest.runtimes['win32-x64'].sha256}`);
