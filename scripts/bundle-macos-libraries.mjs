import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [runtimeArg, ...rootArgs] = process.argv.slice(2);
if (!runtimeArg || !rootArgs.length) throw new Error('Usage: node bundle-macos-libraries.mjs <runtime-dir> <root-relative-path>...');
const runtime = path.resolve(runtimeArg);
const roots = rootArgs.map(value => path.resolve(runtime, value));
const queue = roots.map(filename => ({ source: fs.realpathSync(filename), target: filename }));
const visited = new Set();

function run(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`${command} ${args.join(' ')} failed: ${error.stderr?.toString().trim() || error.message}`); }
}

function dependencies(filename) {
  return run('otool', ['-L', filename]).split(/\r?\n/).slice(1).map(line => line.match(/^\s+(.+?)\s+\(compatibility version /)?.[1]).filter(Boolean);
}

function rpaths(filename) {
  const lines = run('otool', ['-l', filename]).split(/\r?\n/);
  const values = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== 'cmd LC_RPATH') continue;
    const entry = lines.slice(i + 1, i + 5).map(line => line.match(/^\s+path (.+?) \(offset /)?.[1]).find(Boolean);
    if (entry) values.push(entry);
  }
  return values;
}

function expand(value, loader, executable) {
  if (value.startsWith('@loader_path/')) return path.resolve(path.dirname(loader), value.slice('@loader_path/'.length));
  if (value.startsWith('@executable_path/')) return path.resolve(path.dirname(executable), value.slice('@executable_path/'.length));
  if (path.isAbsolute(value)) return value;
  return null;
}

function resolveDependency(value, loader, executable, sourceRpaths) {
  if (/^\/(System\/Library|usr\/lib)\//.test(value)) return null;
  const direct = expand(value, loader, executable);
  if (direct && fs.existsSync(direct)) return fs.realpathSync(direct);
  // CMake-built dylibs can use @rpath install names without recording an
  // LC_RPATH of their own. The build keeps the dependency beside the loader.
  if (value.startsWith('@rpath/')) {
    const sibling = path.resolve(path.dirname(loader), value.slice('@rpath/'.length));
    if (fs.existsSync(sibling)) return fs.realpathSync(sibling);
  }
  const candidates = [];
  for (const rpath of sourceRpaths) {
    const base = expand(rpath, loader, executable) || rpath;
    if (value.startsWith('@rpath/')) candidates.push(path.resolve(base, value.slice('@rpath/'.length)));
    else if (rpath.startsWith('@rpath/')) candidates.push(path.resolve(base, value));
  }
  for (const candidate of candidates) if (fs.existsSync(candidate)) {
    if (/^\/(System\/Library|usr\/lib)\//.test(candidate)) return null;
    const resolved = fs.realpathSync(candidate);
    if (/^\/(System\/Library|usr\/lib)\//.test(resolved)) return null;
    return resolved;
  }
  if (/^\/(System\/Library|usr\/lib)\//.test(value)) return null;
  const base = path.basename(value.replace(/^@rpath\//, ''));
  if (/^(libSystem|libc\+\+|libobjc|libresolv|libcompression|libz|libiconv|libc|libm)\./.test(base)) return null;
  throw new Error(`Could not resolve macOS library dependency ${value} referenced by ${loader}.`);
}

function sha256(filename) { return createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function bundledLibraryPath(source) {
  const directory = path.join(runtime, 'lib');
  fs.mkdirSync(directory, { recursive: true });
  const basename = path.basename(source);
  const normal = path.join(directory, basename);
  if (!fs.existsSync(normal) || sha256(normal) === sha256(source)) return normal;
  const extensionAt = basename.toLowerCase().indexOf('.dylib');
  const splitAt = extensionAt < 0 ? basename.length : extensionAt;
  const suffix = sha256(source).slice(0, 12);
  const candidate = path.join(directory, `${basename.slice(0, splitAt)}-${suffix}${basename.slice(splitAt)}`);
  if (fs.existsSync(candidate) && sha256(candidate) !== sha256(source)) {
    throw new Error(`Could not allocate a unique name for conflicting macOS library ${basename} from ${source}.`);
  }
  return candidate;
}
function bundleLicenses(source) {
  const segments = source.split(path.sep);
  const cellar = segments.indexOf('Cellar');
  if (cellar < 0 || segments.length <= cellar + 2) return;
  const formula = segments[cellar + 1];
  const docDir = path.join(path.dirname(path.dirname(source)), 'share', 'doc');
  if (!fs.existsSync(docDir)) return;
  const destination = path.join(runtime, 'share', 'doc', 'third-party');
  const pending = [docDir];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if ((entry.isFile() || entry.isSymbolicLink()) && /^(license|copying|copyright|notice)(\.|$)/i.test(entry.name)) {
        fs.mkdirSync(destination, { recursive: true });
        const output = path.join(destination, `${formula}-${path.basename(entry.name)}`);
        if (!fs.existsSync(output)) fs.copyFileSync(filename, output);
      }
    }
  }
}
function insideRuntime(filename) {
  const relative = path.relative(runtime, filename);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

for (let index = 0; index < queue.length; index++) {
  const { source, target } = queue[index];
  const key = `${source}\n${target}`;
  if (visited.has(key)) continue;
  visited.add(key);
  const sourceRpaths = rpaths(source);
  for (const dependency of dependencies(source)) {
    const resolved = resolveDependency(dependency, source, roots[0], sourceRpaths);
    if (!resolved) {
      const base = path.basename(dependency.replace(/^@rpath\//, ''));
      if (dependency.startsWith('@rpath/') && /^(libSystem|libc\+\+|libobjc|libresolv|libcompression|libz|libiconv|libc|libm)\./.test(base)) {
        run('install_name_tool', ['-change', dependency, `/usr/lib/${base}`, target]);
      }
      continue;
    }
    let bundled;
    if (insideRuntime(resolved)) bundled = resolved;
    else {
      bundleLicenses(resolved);
      bundled = bundledLibraryPath(resolved);
      fs.mkdirSync(path.dirname(bundled), { recursive: true });
      if (!fs.existsSync(bundled)) fs.copyFileSync(resolved, bundled);
    }
    const relative = path.relative(path.dirname(target), bundled).split(path.sep).join('/');
    const replacement = `@loader_path/${relative}`;
    if (dependency !== replacement) run('install_name_tool', ['-change', dependency, replacement, target]);
    if (!insideRuntime(resolved)) queue.push({ source: resolved, target: bundled });
    else if (!visited.has(`${resolved}\n${bundled}`)) queue.push({ source: resolved, target: bundled });
  }
  if (target.toLowerCase().endsWith('.dylib')) {
    const basename = path.basename(target);
    try { run('install_name_tool', ['-id', `@loader_path/${basename}`, target]); }
    catch (error) {
      if (!/not a dynamic shared library|does not contain an LC_ID_DYLIB/.test(error.message)) throw error;
    }
  }
  for (const stale of rpaths(target).filter(value => /^\/(opt\/homebrew|usr\/local\/Cellar|opt\/local)\//.test(value))) {
    run('install_name_tool', ['-delete_rpath', stale, target]);
  }
}

const all = new Set(queue.map(item => item.target));
for (const filename of all) {
  for (const dependency of dependencies(filename)) {
    if (dependency.startsWith('/opt/homebrew/') || dependency.startsWith('/usr/local/Cellar/') || dependency.startsWith('/opt/local/')) {
      throw new Error(`Unbundled package-manager library path remains in ${filename}: ${dependency}`);
    }
  }
}
console.log(`Bundled macOS native dependency closure (${all.size} files).`);
