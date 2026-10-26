import koffi from 'koffi';

let winApi;
let linuxApi;
let darwinApi;

function windows() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native decoder process management requires Windows x64.');
  if (winApi) return winApi;
  const kernel = koffi.load('kernel32.dll');
  winApi = {
    createFile: kernel.func('void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *templateFile)'),
    control: kernel.func('int __stdcall DeviceIoControl(void *file, uint32_t code, const void *input, uint32_t inputSize, void *output, uint32_t outputSize, _Out_ uint32_t *returned, void *overlapped)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    error: kernel.func('uint32_t __stdcall GetLastError()'),
    createJob: kernel.func('void * __stdcall CreateJobObjectW(void *security, const char16_t *name)'),
    setJob: kernel.func('int __stdcall SetInformationJobObject(void *job, int infoClass, const void *info, uint32_t length)'),
    openProcess: kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    assignJob: kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)')
  };
  return winApi;
}

function linux() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Native decoder process management requires Linux x64.');
  if (linuxApi) return linuxApi;
  const libc = koffi.load('libc.so.6');
  linuxApi = { punchHole: libc.func('int fallocate(int fd, int mode, int64_t offset, int64_t length)') };
  return linuxApi;
}

function darwin() {
  if (process.platform !== 'darwin' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Native decoder process management requires macOS x64 or arm64.');
  if (darwinApi) return darwinApi;
  const system = koffi.load('libSystem.B.dylib');
  darwinApi = { punchHole: system.func('int fcntl(int fd, int command, void *argument)') };
  return darwinApi;
}

function usesProcessGroups() {
  return (process.platform === 'linux' || process.platform === 'darwin') && ['x64', 'arm64'].includes(process.arch);
}

function valid(handle) { return handle !== undefined && handle !== null && handle !== 0n && handle !== -1n && handle !== 0xffffffffffffffffn; }

// A detached Linux decoder owns its process group. Kill the group if the app's
// service exits unexpectedly, and remove the hook when the decoder closes.
export function guardDecoderProcess(pid) {
  if (usesProcessGroups()) {
    const killGroup = () => { try { process.kill(-pid, 'SIGKILL'); } catch {} };
    process.once('exit', killGroup);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      process.removeListener('exit', killGroup);
    };
  }
  const native = windows();
  const job = native.createJob(null, null);
  if (!valid(job)) throw new Error(`Could not create the decoder process job (${native.error()}).`);
  let processHandle;
  try {
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows x64.
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
    if (!native.setJob(job, 9, limits, limits.length)) throw new Error(`Could not configure the decoder process job (${native.error()}).`);
    processHandle = native.openProcess(0x0101, 0, pid); // SET_QUOTA | TERMINATE, this child only.
    if (!valid(processHandle) || !native.assignJob(job, processHandle)) throw new Error(`Could not attach the decoder process job (${native.error()}).`);
  } catch (error) { native.close(job); throw error; }
  finally { if (valid(processHandle)) native.close(processHandle); }
  let closed = false;
  return () => { if (!closed) { closed = true; native.close(job); } };
}

export function signalDecoderProcess(child, signal) {
  if (usesProcessGroups()) {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  child.kill(signal);
}

// Keep the rolling capture sparse: old bytes become unallocated holes, while
// the writer's file position and the newest RF samples remain undisturbed.
export function sparseIqFile(filename, fileDescriptor) {
  if (process.platform === 'linux' && process.arch === 'x64') {
    const native = linux();
    if (!Number.isInteger(fileDescriptor) || fileDescriptor < 0) throw new Error('The RF sample buffer has no valid Linux file descriptor.');
    let closed = false;
    return {
      release(start, end) {
        if (closed || end <= start) return Promise.resolve();
        return new Promise((resolve, reject) => {
          // FALLOC_FL_KEEP_SIZE | FALLOC_FL_PUNCH_HOLE leaves the writer's
          // logical file position and current append offset unchanged.
          native.punchHole.async(fileDescriptor, 3, BigInt(start), BigInt(end - start), (error, result) => {
            if (error || Number(result) !== 0) reject(error || new Error('Could not reclaim the old RF sample buffer.'));
            else resolve();
          });
        });
      },
      close() { closed = true; }
    };
  }

  if (process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch)) {
    const native = darwin();
    if (!Number.isInteger(fileDescriptor) || fileDescriptor < 0) throw new Error('The RF sample buffer has no valid macOS file descriptor.');
    let closed = false;
    return {
      release(start, end) {
        if (closed || end <= start) return Promise.resolve();
        const range = Buffer.alloc(24); // macOS fpunchhole_t: two uint32 fields and two off_t fields.
        range.writeBigInt64LE(BigInt(start), 8);
        range.writeBigInt64LE(BigInt(end - start), 16);
        return new Promise((resolve, reject) => {
          native.punchHole.async(fileDescriptor, 99, range, (error, result) => {
            if (error || Number(result) !== 0) reject(error || new Error('Could not reclaim old RF samples. Use a local APFS volume for the decoder capture.'));
            else resolve();
          });
        });
      },
      close() { closed = true; }
    };
  }

  const native = windows();
  const file = native.createFile(filename, 0xc0000000, 7, null, 3, 0x100, null);
  if (!valid(file)) throw new Error(`Could not open the RF sample buffer (${native.error()}).`);
  const returned = [0];
  if (!native.control(file, 0x900c4, null, 0, null, 0, returned, null)) {
    const code = native.error(); native.close(file);
    throw new Error(`The RF sample buffer needs sparse-file support on local storage (${code}).`);
  }
  let closed = false;
  return {
    release(start, end) {
      if (closed || end <= start) return Promise.resolve();
      const range = Buffer.alloc(16);
      range.writeBigInt64LE(BigInt(start), 0); range.writeBigInt64LE(BigInt(end), 8);
      return new Promise((resolve, reject) => {
        native.control.async(file, 0x980c8, range, range.length, null, 0, [0], null, (error, ok) => {
          if (error || !ok) reject(error || new Error('Could not reclaim the old RF sample buffer.'));
          else resolve();
        });
      });
    },
    close() { if (!closed) { closed = true; native.close(file); } }
  };
}
