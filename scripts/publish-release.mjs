import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repo = new URL(pkg.repository.url).pathname.replace(/^\//, '').replace(/\.git$/, '');
const tag = `v${pkg.version}`;
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  const result = spawnSync('git', ['credential', 'fill'], { cwd: root, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, timeout: 15000 });
  token = result.stdout?.split('\n').find(row => row.startsWith('password='))?.slice(9).trim();
}
if (!token) throw new Error('Provide GH_TOKEN/GITHUB_TOKEN, or sign Git Credential Manager into the repository owner account.');
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'SignalOutpost-release', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(route, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${route}`, { ...options, headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${value.message || 'Request failed'}`);
  return value;
}
const commit = git('rev-parse', 'HEAD');
if (git('rev-parse', `${tag}^{commit}`) !== commit) throw new Error(`Build and publish from the ${tag} commit.`);
const remoteTag = await api(`/git/ref/tags/${tag}`);
let remoteCommit = remoteTag.object;
while (remoteCommit.type === 'tag') remoteCommit = (await api(`/git/tags/${remoteCommit.sha}`)).object;
if (remoteCommit.sha !== commit) throw new Error('The pushed release tag does not match this checkout.');
const out = path.join(root, 'dist');
const installer = `Signal-Outpost-Setup-${pkg.version}-x64.exe`;
const linuxPackages = fs.readdirSync(out).filter(name => /\.(AppImage|tar\.gz|pkg\.tar\.zst)$/i.test(name)).sort();
const macPackages = fs.readdirSync(out).filter(name => /\.(dmg|zip)$/i.test(name)).sort();
if (linuxPackages.length && (!linuxPackages.some(name => name.toLowerCase().endsWith('.appimage')) || !linuxPackages.some(name => name.endsWith('.tar.gz')) || !linuxPackages.some(name => name.endsWith('.pkg.tar.zst')) || !fs.existsSync(path.join(out, 'SHA256SUMS-linux.txt')))) {
  throw new Error('A Linux release must include the AppImage, tar.gz, Arch pacman package, and SHA256SUMS-linux.txt.');
}
if (macPackages.length && (!macPackages.some(name => name.endsWith('-x64.dmg')) || !macPackages.some(name => name.endsWith('-x64.zip')) || !macPackages.some(name => name.endsWith('-arm64.dmg')) || !macPackages.some(name => name.endsWith('-arm64.zip')) || !fs.existsSync(path.join(out, 'SHA256SUMS-mac.txt')))) {
  throw new Error('A macOS release must include x64 and arm64 DMG and ZIP packages, plus SHA256SUMS-mac.txt.');
}
const names = [installer, `${installer}.blockmap`, 'latest.yml', 'SHA256SUMS.txt', ...linuxPackages, ...(linuxPackages.length ? ['SHA256SUMS-linux.txt'] : []), ...macPackages, ...(macPackages.length ? ['SHA256SUMS-mac.txt'] : [])];
for (const name of names) if (!fs.statSync(path.join(out, name)).isFile()) throw new Error(`Missing release file: ${name}`);
const manifest = fs.readFileSync(path.join(out, 'latest.yml'), 'utf8');
if (!manifest.includes(`version: ${pkg.version}`) || !manifest.includes(installer)) throw new Error('The update manifest does not match the Windows installer.');
const localSha512 = createHash('sha512').update(fs.readFileSync(path.join(out, installer))).digest('base64');
if (!manifest.includes(localSha512)) throw new Error('The installer SHA-512 does not match latest.yml. Rebuild before publishing.');
const notesFile = path.join(root, 'docs', 'releases', `${pkg.version}.md`);
const defaultNotes = linuxPackages.length
  ? `Signal Outpost ${pkg.version} for Windows x64, Linux x64, Arch Linux x86_64, and macOS x64 / Apple silicon. Download the Windows installer, Linux AppImage / tar.gz, Arch pacman package, or macOS DMG / ZIP. Windows installations receive updates automatically. The macOS app is unsigned and requires the first-launch confirmation described in the README.`
  : `Windows x64 release of Signal Outpost ${pkg.version}. Download and run ${installer}. Installed applications receive this version automatically.`;
const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : defaultNotes;
const existing = (await api('/releases?per_page=100')).find(release => release.tag_name === tag);
if (existing && !existing.draft) throw new Error(`${tag} is already published. Increase the version; published releases are never overwritten.`);
const release = existing || await api('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: `Signal Outpost ${pkg.version}`, body: notes, draft: true, prerelease: false }) });
for (const name of names) {
  const filename = path.join(out, name);
  const hash = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const prior = release.assets.find(asset => asset.name === name);
  if (prior) {
    if (prior.digest !== `sha256:${hash}`) throw new Error(`The draft already contains a different ${name}. Resolve the draft before publishing.`);
    console.log(`Already uploaded: ${name}`); continue;
  }
  console.log(`Uploading ${name} (${(fs.statSync(filename).size / 1048576).toFixed(1)} MiB)`);
  const url = new URL(release.upload_url.replace(/\{.*$/, '')); url.searchParams.set('name', name);
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(filename).size) },
    body: fs.createReadStream(filename), duplex: 'half', signal: AbortSignal.timeout(600000) });
  const asset = await response.json();
  if (!response.ok) throw new Error(`Upload ${name} failed (${response.status}): ${asset.message}`);
  if (asset.digest && asset.digest !== `sha256:${hash}`) throw new Error(`GitHub checksum does not match ${name}.`);
}
const published = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) });
console.log(`Published ${published.html_url}`);
