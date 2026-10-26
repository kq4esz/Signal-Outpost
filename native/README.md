# RTL-SDR native USB libraries

Linux x64 and macOS x64/arm64 packages use a private, pinned RTL-SDR 2.0.3 library for live
analog, HD Radio and integrated DSD-neo reception. It includes RTL-SDR Blog V4
and V4 Lite support and is backward-compatible with Blog V3 and older or other
compatible RTL2832U dongles. Its source commit is pinned in
`native/digital/source/dsd-neo-32ae7c8.zip`; see the platform runtime build notes
in `native/digital/README.md`. The application selects this library by default;
an explicit library path or `RTLSDR_LIBRARY` environment variable overrides it.
USB device access still follows the distribution's udev rules and permissions.

The Windows x64 native receiver uses the unmodified `rtlsdr.dll`, `pthreadVC2.dll`, and `msvcr100.dll` from RTL-SDR Blog driver release **V1.4.0**. It supports the Blog V4 as well as compatible RTL2832U receivers, including Blog V1–V3. `VCRUNTIME140.dll` is also bundled beside the receiver library: this Blog DLL imports the Visual C++ runtime, so it must not depend on a development PC's installed runtime.

- Binary release: https://github.com/rtlsdrblog/rtl-sdr-blog/releases/tag/V1.4.0
- Corresponding RTL-SDR source: https://github.com/rtlsdrblog/rtl-sdr-blog/tree/V1.4.0
- Source archive: https://github.com/rtlsdrblog/rtl-sdr-blog/archive/refs/tags/V1.4.0.zip
- Original release ZIP SHA-256: `7ef33f1304647f65e5e0fde43637a73d54f076e91e651a3cecc4f55a17fd9815`
- RTL-SDR license: GNU GPL v2 or later; see `COPYING-RTL-SDR.txt` and the upstream source headers.
- The companion pthread and Microsoft Visual C runtime retain their upstream licenses and notices. The original release archive is the source of these companion files.
- The additional `VCRUNTIME140.dll` is an unmodified Microsoft redistributable already supplied with the bundled DSD-neo Windows runtime. SHA-256: `d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066`. Its provenance/notices are retained under `native/digital/`. The same distribution's `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` and `MSVCP140.dll` are copied beside the installed executable during packaging.

The DLL talks to the dongle through libusb/WinUSB. SDR Extreme does not install or change Windows USB drivers. If discovery fails, install WinUSB on the dongle's **Bulk-In Interface 0** with the official RTL-SDR setup instructions. Leave the composite parent and Interface 1 alone.

Use a matching architecture for custom libraries. This build bundles x64 DLLs. Hardware acquisition is isolated in a local helper process; IQ samples travel through an anonymous OS pipe. There is no RTL-TCP receiver or port 1234 dependency.
