# Integrated digital voice engine

SDR Extreme bundles a native Windows x64 **DSD-neo** worker and builds Linux x64 and macOS x64/arm64 workers from the same pinned source. The application manages its lifecycle, chooses the selected USB device, creates channel and talkgroup maps, authenticates its local control connection, consumes structured telemetry, and plays its decoded PCM through the application's audio controls. It is an integrated upstream decoder running in a separate process; the P25/NXDN protocol implementation was not written from scratch for SDR Extreme.

## Pinned build

- Upstream: <https://github.com/arancormonk/dsd-neo>
- Commit: `32ae7c8afba7bb8acbc95d1c6b4099db48d899a0`
- Build channel: **preview**, pinned native MSVC x64 archive plus a Linux x64 source build.
- Binary archive SHA-256: `f8ef451c93c03266d009fa7f39c651acb791fe1839ba91f07def3978127e2b33`.
- Executable SHA-256: recorded in `manifest.json` and checked before every launch.
- The pinned upstream source archive is included in `source/dsd-neo-32ae7c8.zip`; its source hash is recorded in `manifest.json`. It includes CMake build files and dependency pins. `pnpm build:native:linux` and `pnpm build:native:mac` build from the same pinned source, RTL-SDR 2.0.3 and mbelib-neo dependencies, then bundle platform libraries with the decoder.
- Windows runtime files and upstream notices are preserved under `win32-x64/`; dependency provenance and license identifiers are recorded in `win32-x64/sbom.spdx.json`. CI generates Linux runtime files/notices under `linux-x64/` and architecture-specific Mac files/notices under `darwin-x64/` or `darwin-arm64/`.
- The bundled RTL-SDR library uses upstream osmocom v2.0.3 with Blog V4 / V4 Lite support, as pinned in the source's `vcpkg-ports/rtlsdr/portfile.cmake`. The Linux build also installs a stable `librtlsdr-app.so` copy for the app's analog and HD Radio paths, so those modes use the same V4-compatible driver as integrated DSD-neo. Upstream's V4 driver is backward-compatible with V3 and earlier RTL-SDRs.
- The Linux build enables `DETACH_KERNEL_DRIVER`, so the decoder's bundled librtlsdr can detach Debian's `dvb_usb_rtl28xxu` driver when it opens a dongle already claimed by the DVB kernel module.

The preview build supplies the structured control/telemetry API absent from the current stable 2.10.0 release. This copy is pinned to its commit and hash and does not update automatically. Protocol reliability on the user's local systems still requires reception checks.

## Data path

1. DSD-neo opens the dongle through **librtlsdr/libusb and the operating system's USB driver**, using `-i rtl:...`. Windows uses the installed WinUSB driver; Linux requires the user's normal udev USB permission; macOS uses the native USB stack. There is no RTL-TCP IQ connection.
2. The engine performs RF filtering, timing recovery, protocol framing, FEC, trunk following and IMBE/AMBE speech synthesis. Its mbelib-neo codec is included. JMBE and Java are not required.
3. Raw signed 16-bit little-endian PCM travels over the child process's **stdout pipe**. The launch preset fixes its 8 kHz rate and mono/stereo layout. SDR Extreme preserves partial frames between pipe reads, mixes TDMA slots to mono and interpolates to 48 kHz for the existing browser audio path.
4. JSON telemetry/control uses an ephemeral **127.0.0.1** TCP port with a random per-session authentication token. This carries commands and metadata, not USB samples. Tokens are not exposed to the frontend and are removed on shutdown.
5. The engine runs without its terminal frontend. Its stderr is shown in the app's diagnostics. A disconnected control connection stops the session so the UI cannot continue claiming to control an unmanaged decoder.
6. `--iq-capture` supplies raw **CU8 receiver IQ** to a temporary sparse session file. `DecoderSpectrum` reads only the newest four 2048-sample windows, computes a power-averaged complex FFT and publishes ten RF frames per second. The metadata's hardware capture center offset is retained when labelling the frequency axis. Old bytes are reclaimed with Windows `FSCTL_SET_ZERO_DATA`, Linux `fallocate`, or macOS `F_PUNCHHOLE`; about 4 MiB plus the current write block remains allocated. Files are removed after the child exits. The sparse file's logical size can grow, so this is an internal live buffer and is not a valid recording for replay.
7. The Windows child belongs to a job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; Linux and macOS start the child in its own process group and kill that group if the service exits. Sparse-buffer errors stop the session before it can continue accumulating sample data. Hole punching requires local filesystem support (APFS on macOS).

The file controls follow Microsoft's [sparse file operations](https://learn.microsoft.com/en-us/windows/win32/fileio/sparse-file-operations) and [FSCTL_SET_ZERO_DATA](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_zero_data) contracts on Windows, Linux hole punching with `FALLOC_FL_KEEP_SIZE`, and macOS `fcntl(F_PUNCHHOLE)`. The source of this bridge is in `lib/decoder-spectrum.mjs`, `lib/rf-spectrum.mjs` and `lib/native-process.mjs`; the pinned native executable is unmodified.

Only the specific app controls exposed in `server.mjs` are forwarded. Trunked site scanning uses the API's RTL frequency command and channel/group map imports to hop between saved control frequencies without closing the decoder process or USB tuner session. Those scans keep a single decoder profile active. Other runtime mode switching is intentionally performed by stopping and starting a session: the audio layout must agree with the launch preset. Slot preference can change during a session.

## Source and notices

DSD-neo is GPL-3.0-or-later. Preserve the platform runtime's `share/doc/dsd-neo/` license and notice files with the binary. Individual dependencies keep their own notices under `share/doc/third-party/` and their pinned source links in the build script and upstream build pins. The bundled upstream source is unmodified. SDR Extreme's JavaScript integration is under `lib/digital-decoder.mjs` and `lib/digital-audio.mjs`.
