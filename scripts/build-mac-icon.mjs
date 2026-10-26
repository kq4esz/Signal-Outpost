import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets', 'app-icon.png');
const iconset = path.join(root, 'assets', 'mac-app-icon.iconset');
const target = path.join(root, 'assets', 'mac-app-icon.icns');
if (process.platform !== 'darwin') throw new Error('The macOS application icon must be generated on macOS.');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
const sizes = [[16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'], [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'], [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png']];
for (const [size, name] of sizes) execFileSync('sips', ['-z', String(size), String(size), source, '--out', path.join(iconset, name)], { stdio: 'ignore' });
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', target]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(`Generated ${path.relative(root, target)}.`);
