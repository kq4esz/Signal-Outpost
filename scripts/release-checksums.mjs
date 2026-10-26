import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const linux = process.argv.includes('--linux');
const mac = process.argv.includes('--mac');
if (linux && mac) throw new Error('Choose one platform checksum mode per invocation.');
const files = fs.readdirSync(out).filter(name => linux
  ? /\.(appimage|tar\.gz|pkg\.tar\.zst)$/i.test(name)
  : mac
    ? /\.(dmg|zip)$/i.test(name)
  : /\.(exe|blockmap|yml)$/.test(name) && !name.startsWith('builder-')).sort();
if (linux ? !files.some(name => name.toLowerCase().endsWith('.appimage')) || !files.some(name => name.endsWith('.tar.gz')) || !files.some(name => name.endsWith('.pkg.tar.zst'))
  : mac ? !files.some(name => name.endsWith('-x64.dmg')) || !files.some(name => name.endsWith('-x64.zip')) || !files.some(name => name.endsWith('-arm64.dmg')) || !files.some(name => name.endsWith('-arm64.zip'))
  : !files.some(name => name.endsWith('.exe')) || !files.includes('latest.yml')) {
  throw new Error(linux ? 'Build the Linux AppImage, tar.gz, and Arch pacman packages first.' : mac ? 'Build macOS x64 and arm64 DMG and ZIP packages first.' : 'Build the Windows installer and update manifest first.');
}
const rows = [];
for (const name of files) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(path.join(out, name))) hash.update(bytes);
  rows.push(`${hash.digest('hex')}  ${name}`);
}
fs.writeFileSync(path.join(out, linux ? 'SHA256SUMS-linux.txt' : mac ? 'SHA256SUMS-mac.txt' : 'SHA256SUMS.txt'), rows.join('\n') + '\n');
console.log(rows.join('\n'));
