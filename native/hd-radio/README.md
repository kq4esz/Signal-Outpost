# HD Radio runtime

SDR Extreme bundles an unmodified Windows x64 `libnrsc5.dll` from [NRSC5 Studio v0.6.5](https://github.com/LTCAshraven/nrsc5-studio/releases/tag/v0.6.5), and builds Linux x64 and macOS x64/arm64 `libnrsc5` libraries from upstream [nrsc5 v3.2.0](https://github.com/theori-io/nrsc5/tree/v3.2.0). Only the decoder library is used; the NRSC5 Studio application and its SoapySDR stack are not included or launched. Platform builds are generated from the hash-pinned source archive by `pnpm build:native:linux` and `pnpm build:native:mac`.

`manifest.json` pins the platform library paths and hashes. The worker verifies its selected library before loading it. Linux shared-library and macOS `.dylib` dependencies are bundled beside their decoder libraries. HD decoding is isolated in a Node child process and uses the pinned C API from `nrsc5.h`.

The application retains its existing RTL-SDR Blog USB acquisition library, with CU8 I/Q at **1,488,375 complex samples/s**, and feeds the library using `nrsc5_open_pipe` / `nrsc5_pipe_samples_cu8`. This is an anonymous OS pipe with bounded queues rather than an RTL-TCP receiver. The same IQ feeds the application's RF spectrum. Only one reception engine owns the selected dongle at a time.

USB acquisition uses `rtlsdr_read_async` with 32 × 65,536-byte transfers, retaining queued USB requests during JavaScript scheduling pauses. Sample buffers are copied before the native callback returns. Gain/frequency control transfers use Koffi's asynchronous calls so they cannot block the JS loop while the USB reader waits for a registered JS callback. Shutdown cancels the stream and waits for its completion before closing the dongle and unregistering the callback.

HD reception bypasses RTL digital AGC. Automatic tuner gain is implemented in the host using raw ADC sample span and clipping, following [nrsc5's headroom-based gain search](https://github.com/theori-io/nrsc5/blob/v3.2.0/src/nrsc5.c). It starts at manual zero gain, targets approximately -7 dBFS sample span, holds a calibrated level, and recalibrates on clipping or substantial level changes. Manual gain remains available. The browser's shared 48 kHz stereo output maintains a 250 ms reserve; underflows pause consumption until that reserve is rebuilt. Playback diagnostics expose USB throughput, clipping, applied gain, native HDC/PCM counters and both playback buffers.

The native callback emits 44.1 kHz signed 16-bit stereo PCM, ID3 title/artist/album/genre, station identification/slogan/message, service advertisements, MER/BER and LOT image transfers. The host filters audio by program, converts it to stereo 48 kHz float PCM for the shared audio output, and associates image transfers with their service and ID3 XHDR LOT reference. JPEG and PNG artwork is kept in a bounded session cache; broadcast filenames are never used as local file paths. Images are served by session and content identifiers. Frequency changes create a new decoder session and clear audio/metadata/artwork; program changes clear queued digital audio and switch metadata to the selected service.

## Automatic FM fallback

For FM broadcasts, an isolated JavaScript worker demodulates mono FM from the same USB IQ while the native HD worker continues decoding. It uses a windowed FIR channel filter before 5:1 complex decimation, a phase-difference discriminator, an audio FIR before another 5:1 decimation, a DC blocker, 75 µs de-emphasis, and streaming conversion to 48 kHz. The discriminator follows the standard [instantaneous phase-difference equation](https://liquidsdr.org/doc/freqmodem/). No extra dongle or driver connection is opened.

`HdAudioRouter` holds bounded queues, paces 20 ms output blocks, debounces lost HD sync for 250 ms, and returns to HD after at least two seconds of stable decoded audio with 1.6 seconds buffered. Digital PCM arrives in bursts, so recovery considers both decoded audio and queue coverage. FM remains near live audio with a 125 ms playback reserve. A 60 ms transition ramp reduces switching clicks. The host and browser clear stale source audio on transitions. Analog/digital broadcast timing and loudness are not aligned; this is an automatic source switch, not a sample-synchronized blend.

Digital decoder failures, malformed PCM and native input backlog retire only the native worker. USB acquisition, RF plots and FM continue; the native worker is retried at 2, 4, 8, 16 and up to 30 second intervals, resetting the backoff after HD audio recovers. USB failure still stops the session. FM processing runs independently with a bounded input queue; FM worker failures are surfaced without stopping a healthy HD decoder. Disabling fallback terminates the FM worker and keeps digital-only reception. Stop, retune and shutdown terminate both paths and clear the audio router.

Fallback is the analog FM main program on the tuned frequency, including when an HD2–HD8 service is selected. The UI retains the requested digital program and suspends its track metadata/artwork while playing FM. The fallback preference is persisted in local settings and can be changed during reception. AM HD does not use FM fallback.

## Sources and notices

- `source/nrsc5-3.2.0.zip` — pinned upstream source, including Linux dependency/build configuration and the FAAD2 HDC patch.
- `source/build-nrsc5-msys2.ps1` — the binary distributor's build recipe, preserved for provenance; SDR Extreme does not execute it.
- `nrsc5.h` — matching API header provided with the binary distributor's v0.6.5 source.
- `COPYING.GPL-3.0` — nrsc5 license.
- `THIRD_PARTY_NOTICES.md` — preserved distributor notices, including source links for nrsc5's statically embedded FFTW, FAAD2, librtlsdr and libusb. Sections about the Studio GUI, SoapySDR, standalone USB DLLs and GCC/LLVM companion DLLs describe files in the upstream release; those files are not part of this HD Radio directory.

No decoder, artwork, station directory or song data is downloaded at reception time. Actual digital audio and metadata require a receivable NRSC-5 broadcast. The application does not infer HD availability merely from the tuned frequency. RF reception, native codec output, service/track metadata and a broadcast station logo were observed live on WQUT 101.5 MHz HD1 during the v0.5.2 check. Local reports are saved under `local-data/hd-diagnostics`.
