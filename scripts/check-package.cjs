const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Audit the files in the actual distribution, after dependencies are copied.
// Missing sidecars and modified pinned decoders must fail before publication.
module.exports = async function checkPackage(context) {
  if (context.electronPlatformName === 'linux') {
    checkLinuxPackage(context.appOutDir);
    return;
  }
  if (context.electronPlatformName === 'darwin') {
    checkMacPackage(context.appOutDir);
    return;
  }
  if (context.electronPlatformName !== 'win32') return;
  const install = context.appOutDir;
  const app = path.join(install, 'resources', 'app');
  function requireFile(relative) {
    const filename = path.join(app, relative);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error(`Package dependency is missing: ${relative}`);
    return filename;
  }
  // A display-name change must still upgrade the existing Windows application.
  const metadata = JSON.parse(fs.readFileSync(requireFile('package.json'), 'utf8'));
  if (context.packager.appInfo.id !== 'com.sdrextreme.desktop' || metadata.name !== 'sdr-extreme') throw new Error('Signal Outpost must retain the SDR Extreme installation and updater identity.');
  if (metadata.productName !== 'Signal Outpost') throw new Error('The packaged application has the wrong product name.');
  for (const relative of [
    'node_modules/koffi/index.cjs',
    'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
    'node_modules/leaflet/dist/leaflet.js',
    'node_modules/electron-updater/out/main.js',
    'desktop/updates.cjs',
    'desktop/preload.cjs',
    'desktop/startup.html',
    'desktop/startup.css',
    'desktop/startup.js',
    'node_modules/@liamcottle/meshcore.js/src/index.js',
    'node_modules/serialport/dist/index.js',
    'node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node',
    'lib/meshcore.mjs',
    'lib/meshcore-conversations.mjs',
    'lib/meshcore-repeater.mjs',
    'lib/meshcore-delivery.mjs',
    'lib/meshcore-paths.mjs',
    'lib/meshcore-observations.mjs',
    'lib/meshcore-devices.mjs',
    'lib/meshcore-devices.json',
    'lib/MESHCORE_CATALOG_LICENSE.txt',
    'meshcore-ui.js',
    'meshcore.css',
    'theme.js',
    'theme.css',
    'theme-light.css',
    'propagation-ui.js',
    'propagation.css',
    'lib/propagation.mjs',
    'lib/propagation-bands.mjs',
    'lib/iss-orbit.mjs',
    'lib/iss-worker.mjs',
    'lib/wsjt-decodes.mjs',
    'node_modules/satellite.js/dist/index.js',
    'node_modules/satellite.js/dist/propagation/sgp4.js',
    'node_modules/satellite.js/LICENSE.md',
    'native/win32-x64/rtlsdr.dll',
    'native/win32-x64/VCRUNTIME140.dll'
  ]) requireFile(relative);
  for (const [folder, key, property] of [
    ['native/hd-radio', 'win32-x64', 'library'],
    ['native/digital', 'win32-x64', 'executable']
  ]) {
    const manifest = JSON.parse(fs.readFileSync(requireFile(`${folder}/manifest.json`), 'utf8'));
    const runtime = manifest.runtimes?.[key];
    const filename = requireFile(`${folder}/${runtime?.[property] || ''}`);
    const hash = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    if (!runtime?.sha256 || hash !== runtime.sha256) throw new Error(`Pinned native runtime was modified during packaging: ${folder}`);
  }
  const files = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (/\.(dll|exe|node)$/i.test(entry.name)) files.push(filename);
    }
  }
  walk(path.join(app, 'native'));
  files.push(requireFile('node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node'));
  files.push(requireFile('node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node'));
  const system = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
  for (const filename of files) {
    for (const dependency of peImports(filename)) {
      if (/^(api-ms-|ext-ms-)/i.test(dependency)) continue; // Windows API sets.
      const local = [path.dirname(filename), install].some(folder => fs.existsSync(path.join(folder, dependency)));
      // These are redistributable runtimes, even if installed on the build PC.
      const runtime = /^(vcruntime\d|msvcp\d|msvcr\d|libgcc|libstdc\+\+|libwinpthread|pthread)/i.test(dependency);
      if (!local && (runtime || !fs.existsSync(path.join(system, dependency)))) {
        throw new Error(`Unbundled native dependency: ${path.relative(app, filename)} requires ${dependency}`);
      }
    }
  }
  console.log(`Package dependency audit passed (${files.length} Windows x64 native files).`);
};

function checkMacPackage(install) {
  const bundles = fs.readdirSync(install).filter(name => name.endsWith('.app'));
  if (bundles.length !== 1) throw new Error(`Expected one macOS application bundle in ${install}, found ${bundles.length}.`);
  const app = path.join(install, bundles[0], 'Contents', 'Resources', 'app');
  function requireFile(relative) {
    const filename = path.join(app, relative);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error(`Package dependency is missing: ${relative}`);
    return filename;
  }
  const metadata = JSON.parse(fs.readFileSync(requireFile('package.json'), 'utf8'));
  if (metadata.productName !== 'Signal Outpost' || metadata.name !== 'sdr-extreme') throw new Error('The macOS package has the wrong product identity.');
  const arch = process.arch;
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported macOS package architecture: ${arch}`);
  const key = `darwin-${arch}`;
  const koffi = `node_modules/@koromix/koffi-${key}/${key.replace('-', '_')}/koffi.node`;
  const serialPort = 'node_modules/@serialport/bindings-cpp/prebuilds/darwin-x64+arm64/@serialport+bindings-cpp.node';
  const files = [
    requireFile('node_modules/koffi/index.cjs'),
    requireFile(koffi),
    requireFile('node_modules/serialport/dist/index.js'),
    requireFile(serialPort),
    requireFile(`native/digital/${key}/bin/dsd-neo`),
    requireFile(`native/digital/${key}/lib/librtlsdr-app.dylib`),
    requireFile(`native/hd-radio/${key}/lib/libnrsc5.dylib`)
  ];
  for (const [folder, property] of [['native/digital', 'executable'], ['native/hd-radio', 'library']]) {
    const manifest = JSON.parse(fs.readFileSync(requireFile(`${folder}/manifest.json`), 'utf8'));
    const runtime = manifest.runtimes?.[key];
    const filename = requireFile(`${folder}/${runtime?.[property] || ''}`);
    if (!runtime?.sha256 || createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== runtime.sha256) {
      throw new Error(`Pinned native runtime was modified during packaging: ${folder}/${key}`);
    }
  }
  const runtimeDir = path.join(app, 'native');
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && /\.dylib$/i.test(entry.name)) files.push(filename);
    }
  }
  walk(path.join(runtimeDir, 'digital', key));
  walk(path.join(runtimeDir, 'hd-radio', key));
  for (const filename of new Set(files)) {
    if (!/\.(dylib|node)$/.test(filename) && !filename.endsWith(`${path.sep}dsd-neo`)) continue;
    const architecture = spawnSync('file', ['-b', filename], { encoding: 'utf8' });
    if (architecture.status !== 0 || !architecture.stdout.includes(arch === 'x64' ? 'x86_64' : 'arm64')) {
      throw new Error(`Native macOS runtime has the wrong architecture: ${path.relative(app, filename)} (${architecture.stdout.trim()})`);
    }
    const imports = spawnSync('otool', ['-L', filename], { encoding: 'utf8' });
    if (imports.status !== 0) throw new Error(`Could not inspect native macOS dependency: ${path.relative(app, filename)}`);
    for (const line of imports.stdout.split(/\r?\n/).slice(1)) {
      const dependency = line.match(/^\s+(.+?)\s+\(compatibility version /)?.[1];
      if (!dependency) continue;
      if (/^\/(opt\/homebrew|usr\/local\/Cellar|opt\/local)\//.test(dependency)) {
        throw new Error(`Native macOS package has an unbundled Homebrew dependency: ${dependency}`);
      }
      if (dependency.startsWith('@loader_path/')) {
        const resolved = path.resolve(path.dirname(filename), dependency.slice('@loader_path/'.length));
        if (!fs.existsSync(resolved)) throw new Error(`Native macOS dependency is missing: ${path.relative(app, filename)} needs ${dependency}`);
      }
    }
  }
  console.log(`Package dependency audit passed (macOS ${arch} runtimes and native addons).`);
}

function checkLinuxPackage(install) {
  const app = path.join(install, 'resources', 'app');
  function requireFile(relative) {
    const filename = path.join(app, relative);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error(`Package dependency is missing: ${relative}`);
    return filename;
  }
  for (const [folder, property] of [
    ['native/hd-radio', 'library'],
    ['native/digital', 'executable']
  ]) {
    const manifest = JSON.parse(fs.readFileSync(requireFile(`${folder}/manifest.json`), 'utf8'));
    const runtime = manifest.runtimes?.['linux-x64'];
    if (!runtime?.sha256 || !runtime.libraryDirectory) throw new Error(`Linux native runtime was not built: ${folder}`);
    const filename = requireFile(`${folder}/${runtime[property] || ''}`);
    const hash = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    if (hash !== runtime.sha256) throw new Error(`Pinned Linux native runtime was modified during packaging: ${folder}`);
    const header = Buffer.alloc(20);
    const fd = fs.openSync(filename, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    if (header[0] !== 0x7f || header.toString('ascii', 1, 4) !== 'ELF' || header[4] !== 2 || header.readUInt16LE(18) !== 62) {
      throw new Error(`Expected a Linux x86_64 ELF runtime: ${filename}`);
    }
    const libraryDirectory = path.join(app, folder, runtime.libraryDirectory);
    if (!fs.existsSync(libraryDirectory) || !fs.readdirSync(libraryDirectory).some(name => name.includes('.so'))) {
      throw new Error(`Bundled Linux runtime libraries are missing: ${folder}/${runtime.libraryDirectory}`);
    }
    if (property === 'executable' && (fs.statSync(filename).mode & 0o111) === 0) {
      throw new Error(`Linux decoder is not executable: ${filename}`);
    }
  }
  const bundledRtl = requireFile('native/digital/linux-x64/lib/librtlsdr-app.so');
  const rtlHeader = Buffer.alloc(20);
  const rtlFd = fs.openSync(bundledRtl, 'r');
  try { fs.readSync(rtlFd, rtlHeader, 0, rtlHeader.length, 0); } finally { fs.closeSync(rtlFd); }
  if (rtlHeader[0] !== 0x7f || rtlHeader.toString('ascii', 1, 4) !== 'ELF' || rtlHeader[4] !== 2 || rtlHeader.readUInt16LE(18) !== 62) {
    throw new Error(`Expected the pinned Linux x86_64 RTL-SDR library: ${bundledRtl}`);
  }
  const koffi = requireFile('node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node');
  const koffiHeader = Buffer.alloc(20);
  const koffiFd = fs.openSync(koffi, 'r');
  try { fs.readSync(koffiFd, koffiHeader, 0, koffiHeader.length, 0); } finally { fs.closeSync(koffiFd); }
  if (koffiHeader[0] !== 0x7f || koffiHeader.toString('ascii', 1, 4) !== 'ELF' || koffiHeader[4] !== 2 || koffiHeader.readUInt16LE(18) !== 62) {
    throw new Error(`Expected the Linux x86_64 Koffi native module: ${koffi}`);
  }
  console.log('Package dependency audit passed (Linux x64 native decoder runtimes).');
}

function peImports(filename) {
  const bytes = fs.readFileSync(filename);
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error(`Expected a Windows x64 native binary: ${filename}`);
  const count = bytes.readUInt16LE(pe + 6), optional = pe + 24, optionalSize = bytes.readUInt16LE(pe + 20);
  const directories = optional + 112; // PE32+.
  const table = bytes.readUInt32LE(directories + 8);
  if (!table) return [];
  const sections = Array.from({ length: count }, (_, index) => {
    const offset = optional + optionalSize + index * 40;
    return { start: bytes.readUInt32LE(offset + 12), size: Math.max(bytes.readUInt32LE(offset + 8), bytes.readUInt32LE(offset + 16)), raw: bytes.readUInt32LE(offset + 20) };
  });
  function offset(rva) {
    const section = sections.find(value => rva >= value.start && rva < value.start + value.size);
    if (!section) throw new Error(`Invalid import address in ${filename}`);
    return section.raw + rva - section.start;
  }
  const imports = [];
  for (let entry = offset(table); bytes.readUInt32LE(entry + 12); entry += 20) {
    const name = offset(bytes.readUInt32LE(entry + 12));
    imports.push(bytes.toString('ascii', name, bytes.indexOf(0, name)));
  }
  return imports;
}
