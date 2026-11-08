import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceArgument = process.argv[2];
if (!sourceArgument) {
  throw new Error('Pass the extracted pinned DSD-neo source directory.');
}
const sourceRoot = path.resolve(sourceArgument);
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'native/digital/manifest.json'), 'utf8'));
const patch = manifest.sourcePatches?.wfm;
if (!patch?.file || !patch?.sha256) {
  throw new Error('Configure the WFM source patch in the DSD-neo manifest.');
}
if (path.basename(sourceRoot) !== `dsd-neo-${manifest.commit}` || !fs.existsSync(path.join(sourceRoot, 'CMakeLists.txt'))) {
  throw new Error(`Expected the extracted pinned DSD-neo ${manifest.commit} source directory.`);
}

const patchPath = path.join(repoRoot, 'native/digital', patch.file);
const patchText = fs.readFileSync(patchPath, 'utf8').replace(/\r\n/g, '\n');
const patchHash = createHash('sha256').update(patchText, 'utf8').digest('hex');
if (patchHash !== patch.sha256) {
  throw new Error(`Pinned DSD-neo WFM patch hash mismatch: expected ${patch.sha256}, got ${patchHash}.`);
}

const gitDir = path.join(sourceRoot, '.git');
const normalizedPatchPath = path.join(sourceRoot, '.signal-outpost-dsd-neo-wfm.patch');
if (fs.existsSync(gitDir)) {
  throw new Error(`Refusing to patch a source tree that already contains Git metadata: ${sourceRoot}`);
}

let initialized = false;
try {
  // Git for Windows may check the repository patch out with CRLF line endings. Apply
  // a normalized copy so the patch hash and git apply input are platform-independent.
  fs.writeFileSync(normalizedPatchPath, patchText, 'utf8');
  // The source archive hash pins this zero-context patch to the exact upstream revision on every platform.
  execFileSync('git', ['init', '--quiet', sourceRoot], { stdio: 'inherit' });
  initialized = true;
  execFileSync('git', ['-C', sourceRoot, 'apply', '--unidiff-zero', '--check', normalizedPatchPath], { stdio: 'inherit' });
  execFileSync('git', ['-C', sourceRoot, 'apply', '--unidiff-zero', normalizedPatchPath], { stdio: 'inherit' });
} finally {
  fs.rmSync(normalizedPatchPath, { force: true });
  if (initialized) fs.rmSync(gitDir, { recursive: true, force: true });
}

console.log(`Applied the pinned DSD-neo WFM patch to ${manifest.commit}.`);
