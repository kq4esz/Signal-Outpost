# Signal Outpost

*Tune. Decode. Connect.*

Signal Outpost is an Electron desktop receiver suite with native RTL-SDR USB access, a worldwide KiwiSDR receiver map, scanner memories, digital decoding integrations, and a MeshCore companion client. Windows and Linux x64 builds include the bundled HD Radio and DSD-neo decoders. macOS packages are built for Intel and Apple silicon with the same receiver and decoder features.

## Linux desktop packages

Linux x64 releases produce an **AppImage**, a portable **tar.gz**, and an Arch **`.pkg.tar.zst`** package. AppImage is the easiest option across common desktop distributions; the tarball is available for systems without AppImage/FUSE support. The Arch package is built on Arch Linux for Arch and Arch-based distributions such as Manjaro and EndeavourOS. Builds are produced on Ubuntu 22.04 for the generic Linux packages to provide a broad glibc baseline. Linux distributions vary in graphics stacks, system libraries, Bluetooth services and USB rules, so no single package can guarantee support for every distribution or desktop version. ARM Linux is not included.

Linux x64 release packages bundle the pinned RTL-SDR driver used for live analog, HD Radio, and integrated DSD-neo reception. It supports RTL-SDR Blog V1–V4 dongles; Settings can override it with a compatible native library. USB access still requires your distribution’s udev rules and permission for your user account. The Arch package also installs Arch’s `rtl-sdr` package for the system’s usual device setup. Electron needs the normal GTK, graphics and audio runtime libraries for your desktop. Bluetooth Low Energy uses Electron’s device chooser and the desktop’s Bluetooth stack; install and enable BlueZ where your distribution requires it. MeshCore USB serial uses devices such as `/dev/ttyACM0` or `/dev/ttyUSB0`; your user account needs permission to access the serial device (often through the `dialout` group on Debian-based systems). Log out and back in after changing group membership. Do not run the desktop app as root.

The RTL-SDR USB device also needs a distribution-provided udev rule that grants access to your user. Many `librtlsdr` or RTL-SDR packages install one; follow your distribution’s hardware setup guide if the dongle does not appear. Signal Outpost does not change USB rules or kernel drivers.

The Linux build includes live analog reception, HD Radio, integrated DSD-neo digital voice, CW decoding, spectrum/waterfall, KiwiSDR, propagation tools, MeshCore USB serial, Wi-Fi/TCP, and Bluetooth LE where supported by the desktop stack. A compatible Linux DSD-FME executable can also be selected in **Settings → Digital Voice**. Linux builds use manual downloads from GitHub Releases; Windows automatic updates remain available only in the Windows installer.

For broadly compatible Linux packages, build on Ubuntu 22.04 x64, matching the release workflow. Building on a newer distribution can require a newer glibc and reduce compatibility with older systems. Install Node.js 22.12 or newer and pnpm 11.25.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm build:linux
```

The generic Linux build compiles the pinned Linux x64 HD Radio and DSD-neo runtimes before packaging. Install the native build tools listed in the Linux release workflow if they are not already present. The AppImage and tar.gz are written to `dist/`.

To build the Arch package, use an Arch Linux x86_64 system with Node.js 22.12 or newer, pnpm 11.25.0 and the native build tools in the Arch release workflow, then run `pnpm build:arch`. This writes the `.pkg.tar.zst` package to `dist/`. Arch users can install a downloaded release package with:

```sh
sudo pacman -U ./Signal-Outpost-*.pkg.tar.zst
```

The tagged GitHub release workflow builds the generic Linux packages on Ubuntu and the Arch package on Arch Linux, then publishes them with the Windows installer.

## macOS desktop packages

macOS releases include separate Intel x64 and Apple silicon arm64 **DMG** and **ZIP** downloads. They include the pinned RTL-SDR driver, HD Radio and DSD-neo native runtimes, so live reception uses direct USB just as it does on Linux. Use the package that matches the Mac's processor. The app uses Electron 44 and requires **macOS 13 Ventura or later**.

These initial Mac packages are not signed or notarized. The first time macOS blocks the app, open **System Settings → Privacy & Security**, scroll to Security, and choose **Open Anyway** for Signal Outpost; review the warning and confirm **Open**. This confirmation is needed once per installed release. See [Apple's instructions](https://support.apple.com/en-gb/102445). Mac updates are manual: download the newer DMG from GitHub Releases and replace the app in Applications. Memories and settings remain in the user's macOS application-support folder.

USB access does not use Linux udev rules or a Windows WinUSB driver. Connect the RTL-SDR directly and close other SDR applications if they already have the device open. The app bundles its RTL-SDR driver; a custom compatible `.dylib` can be selected in Hardware settings. Bluetooth LE depends on macOS Bluetooth permission and the system Bluetooth stack.

To build locally, use a Mac with Xcode command-line tools, Homebrew, Node.js 22.12 or newer, pnpm 11.25.0, and Homebrew's `autoconf automake cmake fftw libao libsndfile libtool libusb ninja pkg-config` packages. Run `pnpm install --frozen-lockfile`, then use `pnpm build:mac:x64` on Intel or `pnpm build:mac:arm64` on Apple silicon. The native decoder build is compiled on the matching architecture and writes a DMG and ZIP under `dist/`.

The tagged GitHub release workflow builds both Mac architectures alongside Windows and Linux, then publishes their DMG/ZIP files and `SHA256SUMS-mac.txt` together. No Apple signing credentials are configured, so first-launch approval remains required.

## Upgrading from SDR Extreme

**Signal Outpost 0.11.0** continues the SDR Extreme project under its new name.
Existing installations can upgrade through **Help → Check for updates** or by
running the Signal Outpost installer over the current installation. Windows
shortcuts, executable and installer display the new name.

The existing `%APPDATA%\SDR Extreme` profile is reused, including memories,
hardware settings, MeshCore contacts, conversation history and layouts, and
Bluetooth/browser data. The internal package name (`sdr-extreme`) and Windows
app ID (`com.sdrextreme.desktop`) retain their original identifiers for upgrade
compatibility. The GitHub repository is now
[`kq4esz/Signal-Outpost`](https://github.com/kq4esz/Signal-Outpost). The app ID
and existing installation folder can still contain the old name. No profile
move or uninstall is required.

## Start the app

1. On Windows, download the current **Signal-Outpost-Setup** installer from [GitHub Releases](https://github.com/kq4esz/Signal-Outpost/releases/latest), run the installer, then launch **Signal Outpost** from the desktop or Start menu. The installer includes Electron, the local service, USB libraries and decoders; Node.js is not required. Linux users can choose the AppImage or tar.gz package; Arch users can install the `.pkg.tar.zst` release package with `pacman -U`. Mac users should choose the matching x64 or arm64 DMG, move Signal Outpost to Applications, then use the one-time **Privacy & Security → Open Anyway** approval if Gatekeeper blocks first launch.
2. Open **Settings → RTL-SDR device manager**. Click **Refresh**, select your attached receiver, and save the hardware settings.
3. Go to **Live radio** and click **Start listening**. Select a memory or tune to a frequency.
4. Go to **KiwiSDR network** to choose a receiver on the world map or in the station list. Select a station, then click **Check & listen**. Its listening interface opens inside the app; **Open receiver in a new window** offers a dedicated desktop window if a receiver blocks embedding.

For a fresh source checkout, install Node.js **22.12 or newer**, then run `setup-signal-outpost.cmd`. It installs the JavaScript dependencies and desktop runtime. The driver DLLs under `native/win32-x64` must accompany the app. The setup script can also use the bundled Codex Node runtime on this PC.

Windows installs save memory channels, preferences, the receiver directory and window size in **`%APPDATA%\SDR Extreme\data`**. Linux installs use Electron’s platform-native **`~/.config/Signal Outpost/data`** profile; macOS uses **`~/Library/Application Support/Signal Outpost/data`**. Updates preserve this data. **Help → Open saved data folder** opens it. Source checkouts continue to use the ignored `local-data` folder. To migrate from a source checkout, close both versions and copy `channels.json` and `settings.json` from `local-data` into the installed build's data folder; keep a backup before replacing an existing profile. Closing the desktop app releases its receiver. In a source checkout, `stop-signal-outpost.cmd` also stops the local service.

The local UI service uses `127.0.0.1:17890` for the desktop interface and audio/waterfall display. **RTL-SDR hardware access is direct USB through a native RTL-SDR library, with no RTL-TCP process or port 1234 requirement.** Windows uses the bundled V4-compatible `rtlsdr.dll` and WinUSB; Linux uses the bundled pinned V4-compatible library and udev permissions; macOS uses its architecture-matched bundled driver and native USB stack. MeshCore separately supports USB serial, Bluetooth LE and its companion TCP connection over Wi-Fi. `launch-browser-console.cmd` is an optional Windows browser interface to the same native USB backend.

## Appearance

Use the **Light mode** switch beside **Settings** to change between **Dark** and
**Light**. Dark is the default and retains the existing appearance. The app
remembers your choice between launches. The switch also remains available in
the compact sidebar. Switching themes keeps receiver and MeshCore sessions
running; waterfall signal colors and remote KiwiSDR receiver interfaces retain
their own palettes.

For source changes to `app.css` or `meshcore.css`, run `pnpm build:themes` to
regenerate the light color overrides. Windows builds run this step automatically.

## Propagation

Open **Propagation** in the sidebar or press **Ctrl+6** for HF band conditions,
NOAA space weather, ISS tracking and radio-pass predictions, and FT8/FT4
reception activity. Expand **Station & location**, search an address or enter
coordinates, choose a minimum pass elevation, and save your station. Add a
callsign for PSK Reporter queries, or use reception reports from your saved
four-character grid. FT8/FT4 also displays decodes from the shared WSJT-X bridge.
The workspace uses both Light and Dark appearances. See
[Propagation setup, data sources and prediction limits](docs/propagation.md).

## MeshCore companion client

Open **MeshCore** in the sidebar or press **Ctrl+5**. Connect a node running
MeshCore **companion** firmware. The client uses the shared companion protocol
across manufacturers. Choose **Auto / other compatible node**, or select a
specific model to see its USB, Bluetooth and Wi-Fi connection choices.
There is no Heltec-only connection restriction. Model and firmware information
reported by the connected node appear below the connection controls.

### Node advertisements

Below **Local node**, use **Advertise your node** to announce the connected
companion's configured identity and location, if its location policy permits it:

- **Advert Zero Hop** reaches nearby nodes without repeater forwarding.
- **Advert Flood Routed** allows repeaters to relay the advert using the node's
  existing default flood scope.

These controls use the same companion command over USB, Bluetooth LE or Wi-Fi.
Each click requests one advert; the app does not advertise automatically on
connection, startup, refresh or reconnect, and does not automatically retry a
rejected or ambiguous request. Buttons show pending state, and node acceptance
or errors appear below them. Acceptance confirms the node queued the request;
it is not a receipt from remote nodes. Requests are bound to the selected node
and connection so an old queued request cannot advertise a newly connected node.

The bundled catalog covers **94 official companion board profiles** from
MeshCore's **companion-v1.18.0** release, checked October 15, 2026. This includes
Heltec, RAKwireless, Seeed Studio, LilyGO, Elecrow ThinkNode, Waveshare, and other
manufacturers, with radio/display variants listed separately. See the full
[device and transport table](docs/meshcore-devices.md). Auto also accepts
compatible unlisted boards and custom firmware using the same protocol.

The model selector offers interfaces across the board's companion builds;
the firmware actually installed on the node determines which are enabled.
Wi-Fi is disabled for profiles without an upstream Wi-Fi companion interface.
Use their supported USB and/or Bluetooth connection. USB-only hardware remains
USB-only; a desktop client cannot add a Bluetooth or Wi-Fi radio. Interfaces
defined only in source are marked as requiring a custom firmware build in the
connection instructions. Selecting a model does not flash or configure its firmware.

- **USB:** plug in a USB data cable, refresh the serial port list, select the
  node's port, then connect. The serial connection uses **115200 baud**.
  Install the USB serial driver appropriate to the board if Windows does not
  expose a serial port. On Linux, your user needs permission to open its
  `/dev/tty*` device. Close other applications using that port. On Windows, do
  not replace the node's serial driver with the RTL-SDR WinUSB driver. nRF52
  and RP2040
  boards must be in normal USB serial mode, not their UF2 bootloader. Boards
  exposing a UART may require a supported USB-to-UART adapter.
- **Bluetooth:** enable Bluetooth on your computer, run BLE companion firmware,
  click **Choose Bluetooth node**, select the node, and enter/confirm its PIN.
  Device selection and PIN prompts are provided inside the desktop app.
  Close other MeshCore apps connected to the node. A browser console requires
  a browser with Web Bluetooth support, such as Chrome or Edge. Normal discovery
  accepts the MeshCore service UUID and MeshCore device-name prefixes. If a
  custom name or incomplete advertisement hides the node, select **Show all
  Bluetooth devices**; the selected device must still expose the MeshCore
  companion service and characteristics before it can connect.
- **Wi-Fi:** run firmware exposing the MeshCore companion TCP service, then
  enter the node IP/hostname and TCP port (default **5000**). This is the binary
  companion service, not a node's HTTP page. Wi-Fi support is not added to a
  USB/BLE-only firmware build by selecting this option.

USB serial uses the bundled native SerialPort binding. Bluetooth LE uses Electron's
Web Bluetooth support through the operating-system Bluetooth stack, with an in-app
device chooser and PIN pairing. Linux BLE requires a working BlueZ desktop setup.
No external MeshCore application or Python client is required. The standard
protocol connection works with older compatible firmware, including the previously
used 1.17.1; the catalog does not force a firmware update.

Repeaters, room servers, bootloaders and standalone chat firmware do not
automatically expose the companion chat protocol. To use such a board as the
local chat client, it needs compatible companion firmware. The app does not
change its role or flash firmware automatically.

The client reads the node identity, LoRa profile, battery voltage, configured
channels and contact list, and retrieves waiting messages. Select a channel
or chat contact to send a text message. Select a repeater for its LoRa login,
status and command console, described below. Room-server login and commands
are not implemented. Configure
new contacts/channels using an existing MeshCore companion app, then use
**Sync node** here. No firmware flashing or radio-parameter editing is performed.

**Channels** and **Contacts** have separate selectable tabs, each with its own
conversation selection and search. Switching between them keeps unsent drafts.
Unread badges show the number of new incoming messages for each conversation,
the total for each category tab, and the overall total beside MeshCore in the
main navigation. Outgoing messages and delivery receipts do not add to these
counts. Search and Favorites do not hide a category's unread total.

Drag an entry by its **⋮⋮** handle to rearrange the list. Click its **star** to
favorite it, and use **Favorites** above the list to show only starred entries.
Click the **pin** to keep a channel or chat in the **Pinned** section above
the regular list. Favorites and pins are independent. Drag within either group
to arrange it; dropping on an entry in the other group adopts that entry's
pinned/unpinned status. Search and Favorites preserve the order of hidden entries.
You can also drag the **Channels / Contacts** tabs to swap their positions.
For keyboard access, focus a drag handle and press **Alt+Up / Down**, or focus
a category tab and press **Alt+Left / Right**. Layout, favorites, pins and tab
order are saved locally for each node and restored when it reconnects after an
app restart. Syncing the node or receiving messages keeps that saved layout.

Messages become read when their conversation is open in the visible, focused
MeshCore workspace and scrolled to the latest message. If you are reading older
messages, **N new messages ↓** takes you to the latest messages. Unread state is
saved with local history, scoped to the node, and restored after reconnecting
following an app restart. Existing history from versions before 0.7.1 starts as
read; newly retrieved messages are counted as unread.

### Repeater login over LoRa

Connect your companion node using USB, Bluetooth or Wi-Fi, then open **Contacts**
and select an existing **Repeater** entry. Enter its password and click
**Connect & log in**. A blank password can use an existing repeater ACL entry.
The app waits for the repeater's login response, shows its access level, and
displays whether the current route is direct, relayed or still using flood
discovery. Guest logins can request status; administrator logins can send
repeater CLI commands. Legacy repeaters may confirm login without reporting
their access level, so the repeater itself determines which commands it accepts.

**Refresh status** requests battery, uptime, RSSI/SNR, noise floor, TX queue,
packet counts and error flags. Use the command field or the **Version**, **Clock**
and **Radio settings** shortcuts to prepare a command, then click **Send command**.
Commands are sent as CLI data; the app waits for a reply rather than a chat ACK.
No reply does not prove a command failed, and commands are never retried automatically.

After login, **Advert Flood from Repeater** requests a flood advert from the
selected repeater using the `advert` command. Administrator access is required.
Its reply appears in the console, and any unsent command draft is preserved.

Login credentials are not saved or put into chat history. New repeater command
and response logs stay in RAM (up to 100 entries per repeater) and clear when
the companion disconnects or the app session ends. **End session** stops the
companion-managed connection and clears this app's login and console; it does
not revoke authorization stored in the repeater's ACL. Reconnects require login
again. This feature uses the companion's LoRa radio; it does not connect the PC
directly to a repeater's USB console. See [repeater details and protocol references](docs/meshcore-repeaters.md).

### Message receipts, retries and paths

Direct chat messages make **up to four attempts**, stopping immediately when
the recipient's ACK confirms delivery. Retries retain the original timestamp
and use protocol attempt numbers 0–3. Late ACKs from earlier attempts still
confirm the same chat entry. After two unacknowledged attempts on a known route,
remaining attempts can reset that contact's route to flood discovery. Waits
follow the node's estimated timeout. Permanent errors stop retries immediately;
temporary busy/full errors receive bounded backoff.

Each channel message stops after the **first send accepted by the local node**.
Only an explicit node send error triggers another attempt, with backoff and a
maximum of four attempts total. Retries keep the same timestamp. Disconnects,
timeouts and ambiguous local responses stop the send instead of repeating a
broadcast that may already be queued. Channels have no recipient ACKs:
**Sent to node** remains explicitly **recipient receipt unavailable**.

Click **Receipt & path** on a sent message for its ACK, round-trip time,
attempts and route information. Delivered direct messages show relay counts
when available. An outbound route snapshot, a route learned near delivery and
an observed ACK return path are labeled separately. MeshCore's normal receipt
does not supply a complete verified forward path. Unknown paths or relay names
remain unknown, and short-hash identity collisions are marked ambiguous. Zero
relay hops means one direct radio link. See [delivery details](docs/meshcore-delivery.md).

Pending messages are queued as individual chat entries; an ACK stops further
attempts. Receipts and attempt history are saved locally. Disconnect or app
restart stops pending attempts, and reconnecting never silently resends them.
Repeater console commands retain their reply-based confirmation and do not
automatically replay administrative operations. The composer counts UTF-8 bytes
and reserves sender-name space for channel messages. Enter sends; Shift+Enter
adds a line.

Up to 1,500 messages are retained in `meshcore.json` in the saved data folder,
scoped to the connected node's public identity. Message text is stored locally
in plain text. Channel keys, private keys, and Bluetooth PINs are not saved.
The app does not connect or transmit messages until the user requests it.
MeshCore runs independently of the RTL-SDR receiver.

The implementation uses the [official JavaScript library](https://github.com/meshcore-dev/meshcore.js)
and [MeshCore companion protocol](https://github.com/meshcore-dev/MeshCore/blob/main/docs/companion_protocol.md).
The model catalog is bundled for offline use. Update it for a later release
with `pnpm update:meshcore-devices`, review the generated JSON/table, and publish
an application update. This reads upstream metadata without downloading firmware
or executing upstream code. Physical node reception, RF delivery and Bluetooth
pairing depend on the connected hardware and firmware; they cannot be established
for all board models by a package build or catalog generation.

## Windows installation and automatic updates

The Windows 10/11 x64 installer creates desktop and Start menu shortcuts and
installs for the current user. A supported RTL-SDR still needs the WinUSB
hardware driver described below. This release is unsigned because no code
signing certificate is configured; Windows SmartScreen can display an
unknown-publisher warning. Download from this project's releases and compare
`SHA256SUMS.txt` when checking a downloaded installer.

The startup updater, introduced in **SDR Extreme 0.10.2**, immediately checks
**kq4esz/Signal-Outpost** releases before opening the receiver. A startup screen
shows download progress; available stable updates install automatically and
reopen the updated app. Downloads use HTTPS and SHA-512 verification.
**Open Signal Outpost now** continues the check/download in the background.
Checks taking over 12 seconds and downloads taking over two minutes also
continue in the background so a slow or offline connection does not block use.

While the receiver is open, checks run hourly. An in-app notice shows downloads,
errors, the installed/available versions, and **Restart and install** when ready.
Background downloads install after a chosen restart or normal app exit, once
the receiver service has stopped. **Help → Check for updates** checks manually
and shows errors. Failed checks/downloads retry after 1, 5, 15, then 30 minutes;
resuming Windows or the app regaining connectivity can trigger another check.
Errors and update state are recorded in `updates.log` and `updates.json` in
the saved data folder (**Help → Open saved data folder**).
Automatic updates run only in packaged builds. No GitHub token is included
in the application or needed by users to download public releases.

### Clients still running an older version

Versions through 0.10.1 check 15 seconds after launch and silently download;
they install after normal exit, not immediately on opening. Use
**Help → Check for updates**, allow the download to finish, then choose
**Help → Restart to install update**. If that check/download fails or the version
still stays old, close the app and run the latest setup executable from
[GitHub Releases](https://github.com/kq4esz/Signal-Outpost/releases/latest) over the
existing installation. Use the same Windows account and installation folder.
Memories, MeshCore history, and settings are preserved; do not uninstall or
delete the saved data folder. This brings the corrected startup updater to
clients that cannot retrieve it through their existing updater.

### Build and publish another version

Use Node.js 24 and pnpm 11.25.0 on Windows x64:

```powershell
pnpm install --frozen-lockfile
pnpm build:win
pnpm release:checksums
```

The installer, `.blockmap`, `latest.yml` update manifest and `SHA256SUMS.txt`
are written to `dist/`. On Linux, `pnpm build:linux` writes the AppImage and
tar.gz; `pnpm build:arch` writes the Arch `.pkg.tar.zst` package. Release checksums
cover all Linux packages. On a Mac, `pnpm build:mac:x64` or `pnpm build:mac:arm64`
writes architecture-specific DMG and ZIP files. `pnpm build:dir` produces an unpacked executable for
local development. Native workers and DLLs are shipped as regular files so
their OS paths and library hashes remain valid. Build output and personal
`local-data` are excluded from Git.

The Windows package includes its x64 Koffi addon and required Visual C++ runtime
sidecars; the Linux and macOS packages resolve Koffi and SerialPort for their
target platform on their build runners. Package dependency audits check native
imports and bundled decoder hashes before release assets are produced. USB sample
callbacks copy native memory with `koffi.decode`; external ArrayBuffer views
are incompatible with Electron's V8 memory cage, including its Node helper
processes. Version 0.6.2 includes the first-sample crash fix and corrects the
HD startup response so the controls leave their waiting state after startup.

For future releases, update `package.json`'s version; the sidebar reads the
running app version automatically. Add notes in `docs/releases/<version>.md`,
commit and push the source, then push a matching `v<version>` tag. The release
Actions workflow builds Windows, generic Linux, Arch, macOS Intel and macOS Apple
silicon packages in parallel, then publishes them together from a draft release. Its scoped `GITHUB_TOKEN` supplies publishing access; no
personal access token needs to be committed or configured for this workflow.
Published versions are never overwritten. The release script rejects a tag,
installer or manifest that does not match the version being published.

To publish a tagged build locally, push the tag first and use
`node scripts/publish-release.mjs` after building/checksums. It reads
`GH_TOKEN`/`GITHUB_TOKEN` or the existing Git Credential Manager login and
keeps credentials in memory. Use either the Actions publishing path or the
local path for a version, not both at once.

Source and bundled native components retain their respective licenses; see
`LICENSE`, `THIRD_PARTY_NOTICES.md` and the notices/source archives under
`native/`.

## USB hardware and driver settings

The bundled RTL-SDR Blog V1.4.0 x64 library supports Blog V4 receivers and compatible RTL2832U dongles. On this PC, native discovery identifies **RTLSDRBlog / Blog V4**, serial **00000001**, with the **R828D** tuner and an installed WinUSB driver. Live USB sample reception, retuning, manual gain and clean release were verified during this update.

For other PCs, follow the [official RTL-SDR Windows setup guide](https://www.rtl-sdr.com/rtl-sdr-quick-start-guide/): install **WinUSB on Bulk-In Interface 0**, keeping the composite parent and Interface 1 unchanged. The app does not replace Windows drivers automatically. Close other receiver applications before opening a dongle.

Hardware controls include USB device selection (remembered by serial), 1.024–3.2 MSPS sample rate, supported manual gain / automatic tuner gain, PPM frequency correction, tuner bandwidth, RTL digital AGC, direct sampling I/Q selection and bias tee control. Changes to sampling controls take effect after reconnecting. Higher sample rates may drop samples on some USB controllers. Bias tee is off by default and supplies antenna DC power when enabled.

**Blog V4:** leave sampling input at Quadrature for HF. Its internal upconverter is handled by the Blog driver. **Blog V3:** HF may require Direct sampling Q branch. A custom matching x64 DLL can be selected under Driver library & diagnostics.

## KiwiSDR network atlas

- Pan and zoom the world map; click a station or choose one from the matching list.
- Search by country, city, callsign, locator grid or antenna description.
- Filter to receivers with free slots, favorites or the visible map area; sort by HF SNR, free slots or name.
- View antenna, hardware, coverage, grid locator, HF SNR and user capacity before connecting.
- Save favorites locally and return to them later.
- The selected receiver's `/status` endpoint is checked before its listening page opens. Full/offline receivers are blocked when the current check confirms that state. If a host's status cannot be reached, the app explains this and permits trying its page.

Receiver metadata comes from [Pierre Ynard / Linkfanel's public KiwiSDR directory](http://rx.linkfanel.net/), cached for five minutes, with the last saved data available during outages. This is an independently published receiver feed; the app does not bypass the KiwiSDR website's human access check. Map imagery is from OpenStreetMap, displayed with attribution. Internet access is needed for directory refresh, map tiles and remote listening. Directory capacity is a snapshot, and slots can fill before a session connects. Remote receivers can impose passwords or listening limits. Some hosts block embedding; use the dedicated receiver window in that case.

## Included receiver features

- Native RTL-SDR USB control, with device identity, tuning, sample-rate selection, manual/automatic gain, PPM, AGC, tuner bandwidth, HF sampling controls and local audio playback.
- Live FFT spectrum and waterfall.
- HD Radio FM/AM reception with HD1–HD8 selection, stereo playback, station/track information and broadcast artwork, through bundled nrsc5.
- Analog receive modes: AM, narrow FM, wide FM, USB, LSB, and CW, plus a raw-IQ monitor setting. FM is mono. The simple browser DSP uses a 48 kHz audio path; wide-FM stereo/RDS and advanced filtering are not included yet.
- Basic CW/Morse text decoding from the CW demodulated audio. Treat this first decoder as experimental; weak or noisy signals can produce errors.
- Conventional memory channels with local add/edit/delete, groups, search, CSV/JSON import, JSON export, selected rapid scanning, signal hold, automatic resume after silence, and Skip/Stop controls.
- KiwiSDR world map and station browser, availability checks, local favorites, embedded listening and dedicated receiver windows.
- FT8/FT4 decode display through WSJT-X UDP decode messages. For audio, choose a virtual cable playback output in Settings, select its paired recording input in WSJT-X, and configure WSJT-X to send UDP decodes to `127.0.0.1:2237`. For example, VB-CABLE playback **CABLE Input** is paired with recording **CABLE Output**. Keep WSJT-X in receive-only use with this app.
- Integrated native digital voice decoder: **P25 Phase 1/2, NXDN48/96, DMR, D-STAR, YSF and M17**, using a bundled DSD-neo core and its included IMBE/AMBE codec. It opens the RTL-SDR directly over USB, follows saved trunked sites or selected conventional memories, and plays decoded voice through Signal Outpost's volume, mute and audio output controls. The workstation displays call slots, talkgroups, source radio IDs, system/control information, RF metrics, P25 FEC quality, call events and diagnostics. A separately configured DSD-FME engine remains available in Settings.

## HD Radio

On **Live radio**, tune an FM broadcast frequency from **87.5–108 MHz** or an AM broadcast frequency from **0.530–1.710 MHz**, then choose **Listen in HD** in the HD Radio panel. You can also select **HD Radio** in Demodulation and use the main listen button. The app switches the selected dongle from its previous reception engine to the HD decoder. Ordinary analog stations do not acquire an HD lock: use **Listen in FM / AM** to receive their analog audio. The receiver must be capable of the selected frequency; AM on Blog V4 uses Quadrature mode and its built-in upconverter.

- **HD1–HD8** selects a zero-based native audio program, shown with the familiar one-based HD label. Advertised services light up as their descriptors arrive; an unadvertised program can be selected to wait for it. Restricted services are identified. Acquisition can take several seconds, and weak signals may lose lock.
- Station name, slogan/message, song title, artist, album, genre, MER and BER appear when supplied by the broadcast. The main app volume, mute and output device apply to HD audio, with both stereo channels retained.
- **Automatic FM fallback** is on by default and saved locally. During FM HD reception, a separate mono FM demodulator uses the same centered USB IQ, keeping nrsc5 running. FM plays while HD acquires, after a sustained loss of lock, when decoded audio runs out, or while a failed HD worker restarts with bounded retry backoff. The player identifies the actual audio source. The selected HD program returns after stable lock/audio and a recovery buffer; brief sync changes are debounced. Short source-change ramps reduce clicks, but broadcast analog/digital delay and loudness are not aligned.
- Fallback uses the **FM main program at the same frequency**. For HD2–HD8 this can be different content. The selected HD subchannel is retained for recovery and for memory saving. HD song details and artwork are paused while FM is playing so they are not presented as FM metadata. The fallback toggle can be changed during reception; it applies to FM broadcast frequencies. AM HD reception retains its manual **Listen in AM** option.
- **Album art / station logos** come from the station's over-the-air LOT image transfers and ID3 artwork references. Artwork is associated with the current program, not taken from an unrelated song search. Some stations supply no art or no track metadata, and images can arrive later than text. No Internet metadata account or external music service is required.
- **Save HD memory** opens a reviewable memory draft for the tuned frequency and selected HD program. The general **Add current to memory** button also retains the active HD subchannel. HD memories can be edited, imported/exported as JSON and recalled individually. Rapid scanning excludes HD memories because the receiver needs time to acquire each digital broadcast.
- Live radio and Decoders both display the HD receiver's actual IQ spectrum and waterfall. HD reception uses the selected RTL-SDR USB device/serial, PPM and bias tee. It fixes the IQ rate at **1.488375 MSPS**, uses full automatic tuner bandwidth, and turns **RTL digital AGC off** for this session. Hardware settings' automatic gain selects an ADC-headroom controller, beginning at manual 0 dB and choosing a supported gain near -7 dBFS peak span. Once calibrated it holds gain through normal variations and responds to overload or large RF level changes. A manually selected gain is respected. The normal analog sample rate and RTL AGC preference are retained.
- USB acquisition uses **32 queued asynchronous transfers**, with nonblocking gain and frequency controls. The browser keeps a **250 ms playback reserve** and rebuffers on a real underrun instead of repeatedly emitting short gaps. **Playback diagnostics** shows actual sample rate, gain/RTL AGC, clipping, HD and browser buffers, underruns, and native silent-block counts. If browser autoplay leaves the output suspended, use **Resume audio** there.

The app bundles **nrsc5 v3.2.0**, including its HDC audio decoder, for Windows and Linux x64. The Linux shared library is built from the pinned upstream source at package time. Source, pinned hashes, API headers, build recipes and preserved license notices are in [native/hd-radio](native/hd-radio/README.md). The decoder runs inside an app-managed worker and receives samples over an anonymous pipe from the existing direct-USB receiver; it does not need a second dongle, an RTL-TCP server, or a separately installed HD Radio player. Version 0.5.2 was live checked on **101.5 MHz WQUT HD1** using this PC's Blog V4. Signal conditions and appropriate manual gain vary by station and antenna.

## Integrated digital voice

Open **Decoders**, choose a protocol and click **Start decoder**. For a saved trunked system, select its memory and site first. Tune a conventional digital memory from Memory channels to retain its phase, modulation and identity settings. Stop the current decoder before changing protocol. **Audio slot** sets the native TDMA slot preference; **Return to control** returns a trunked session to its control channel. The application's audio output and volume controls also apply to the integrated decoder.

The app bundles an unmodified native DSD-neo worker with its own DSP, protocol/FEC, trunking and voice codec implementations. Signal Outpost manages that worker as part of the app. **Java and JMBE are not required** for this engine. JMBE provides the speech codec stage; it does not replace RF demodulation and P25/NXDN frame decoding.

The bundled build is a **preview**, pinned to upstream commit `32ae7c8afba7bb8acbc95d1c6b4099db48d899a0`. Its structured control API is not yet in upstream's stable 2.10.0 release. Windows uses the pinned native archive; Linux x64 builds the same source and API as part of Linux packaging. The app checks the decoder executable's SHA-256 before launch. Source, dependency information and preserved license notices are in [native/digital](native/digital/README.md). It does not download or update the decoder at runtime.

The native decoder receives RF over USB; decoded PCM returns over an OS pipe. An authenticated connection on an ephemeral loopback port carries commands and telemetry. **No RTL-TCP receiver is used.** The native decoder's 48 kHz DSP stream is separate from the analog receiver's configurable IQ sample rate. The selected USB device/serial, gain, PPM and bias-tee setting are applied; digital reception requires quadrature sampling. The decoder owns the dongle during reception.

**Decoders includes an RF spectrum and waterfall.** The integrated engine's raw receiver IQ feeds a 2048-bin, Hann-windowed FFT, averaged over four windows, at up to ten updates per second. The frequency axis follows the hardware capture center and sample rate; a green marker identifies the tuned frequency, including the native receiver's offset tuning. The same RF feed is available on Live radio. With the analog USB receiver running (including CW), Decoders displays that receiver's existing RF feed. An external DSD-FME process does not expose this integrated RF feed.

Click a point in either live waterfall to tune to the frequency under the pointer. Use **− / +** or the mouse wheel to zoom; wheel zoom follows the pointer. **Wide survey** displays a 0–2.4 GHz panorama by retuning the connected RTL-SDR across the bands supported by its tuner. It pauses audio while sweeping, and the survey can take time to cover the range. One RTL-SDR receives only a small frequency window at a time, so this is a sequential survey rather than simultaneous full-band reception. Frequencies outside the connected tuner and application's tuning limits cannot be tuned. Wide survey requires analog Live radio reception; stop HD Radio or digital decoding first.

Use **Freeze / Resume** to pause the decoder RF display while reception continues. **Clear waterfall** clears its history. Changing frequency clears the history to keep every row on the same frequency axis. A paused view is labelled PAUSED; stopped or stalled reception shows a waiting/idle state. The native RF bridge uses a temporary sparse IQ buffer in the session folder, reclaims old data in 64 KiB units, keeps approximately 4 MiB of recent allocated sample data, and removes its files on normal shutdown. It requires local sparse-file support. Its logical file size grows during a session; it is not a saved recording. Windows job objects and Linux process groups terminate the native decoder if its owning service exits, preventing an orphaned writer.

**Add current to memory** is available on Live radio and the decoder RF toolbar. It takes a fresh snapshot of the receiver's tuned frequency and mode and opens a new conventional memory for review. It preserves P25 phase/modulation/identity settings and NXDN48/96, uses a detected protocol when available, and includes known source/talkgroup context in notes. During trunk following, it captures the currently tuned control or voice frequency. Enter or edit the name, then **Save channel**; Cancel, Close and Escape discard the draft. The button also works with the idle frequency/protocol selection. It never overwrites an existing memory.

Start succeeds only after the worker's API authenticates and it reports a running USB stream. Signal lock and intelligible speech additionally require valid received frames. Local P25/NXDN reception and trunk following remain unverified in this update. Encrypted calls are indicated and their unavailable audio remains muted. The event display retains up to 100 received records per session; Clear view clears the current window's display.

## Memory protocols and selected scanning

Cancel, the close button and Escape dismiss memory dialogs without validating required fields or writing a channel. Save is the only action that creates or updates a memory. Imported trunked memories retain other sites and talkgroups when their primary site is edited.

P25 memories store **Phase 1**, **Phase 2**, or **Auto**, plus modulation and optional WACN/system ID/NAC in hexadecimal. For Phase 2 trunked systems, set the **control channel type** separately: many Phase 2 voice systems use a Phase 1 FDMA control channel. The app uses the native core's mixed P25 decoder for that case, and its Phase 2 / 6000-symbol QPSK options for a TDMA control channel. For direct Phase 2 voice, supply all three identity values when the signal lacks sufficient identity information. The decoder learns normal trunking identities from the control channel.

NXDN memories explicitly select **NXDN48 (4800 bps / 6.25 kHz)** or **NXDN96 (9600 bps / 12.5 kHz)**. These choices select the corresponding native decoder preset. Existing generic NXDN memories default to NXDN48, matching the previous build; edit them if their system uses NXDN96. New manual trunked memories include a primary site automatically, and accept additional site frequencies as `LCN, MHz, role`, preserving LCN zero. Enter the correct channel numbers for NXDN sites that need a channel map.

In **Memory channels**, check conventional channels or trunked systems, choose a dwell time, then click **Scan selected**. The saved selection is retained for the next app session after starting a scan. **Select visible conventional** or **Select visible trunked systems** selects the current search/filter results; **Clear selection** empties it. Conventional and trunked selections are kept separate.

One RTL-SDR visits separated frequencies sequentially; this option does not receive all selected frequencies simultaneously. Native rapid dwell choices are 80, 150 and 250 ms, with standard 500 ms / 1.5 second options. Actual visit rate includes hardware tuning time. Signal hold uses channel energy above nearby spectrum noise; scanning resumes after the selected silence interval. Use **Skip active** to leave a continuous transmission, or **Stop** to remain on the current channel. Fast hopping can miss short bursts or weak signals.

Selected digital conventional memories use the decoder core's fastest scan setting or a one-second hangtime, with its own activity hold. Native analog and digital memories need separate scan groups. P25/DMR can use the combined decoder; NXDN48 and NXDN96 need separate groups. Trunked site scanning rotates through every saved primary and alternate control frequency for the selected systems, keeping one integrated DSD-neo decoder and RTL-SDR USB session open while it retunes between frequencies. It reloads the selected site's channel and talkgroup maps on each hop. Choose a 1–30 second dwell (2 seconds by default); frequency settling time adds to each visit. Systems with different decoder settings need separate scans. **Hold on an active signal** keeps the receiver on a decoded call until it ends, then waits for the selected hang time; **Skip active** advances immediately. The status shows the current system, site, frequency and control-channel lock / call activity. A single RTL-SDR checks these frequencies sequentially, so it can miss activity while tuned elsewhere. Trunked scans require the integrated decoder.

Decoder presets follow the [DSD-neo CLI documentation](https://github.com/arancormonk/dsd-neo/blob/32ae7c8afba7bb8acbc95d1c6b4099db48d899a0/docs/cli.md) and the compatible [DSD-FME usage guide](https://github.com/lwvmobile/dsd-fme/blob/audio_work/examples/Example_Usage.md).

## RadioReference import

The import screen uses RadioReference's official SOAP database service. It supports:

- Trunked systems by RadioReference system ID, including site frequencies and talkgroups.
- Conventional county frequencies by 5-digit US ZIP code.

Each user must supply their own approved application key and their own Premium account credentials. The importer sends these credentials to RadioReference for the request, does not store them, and saves only the resulting channel data locally. Fully encrypted talkgroups and frequencies are omitted from the generated decoder lists. The conventional import caps each import at 500 memories and queries up to 180 frequency subcategories.

Request API access through [RadioReference's application page](https://www.radioreference.com/account/api/apply). The integration follows their [Database Web Service API requirements](https://support.radioreference.com/hc/en-us/articles/18844460198932-Database-Web-Service-API). The API key must be approved before online import can work.

## Digital-mode boundaries

“All demodulation modes” is open-ended: protocols require different demodulators and decoders. This build covers common analog modes, Morse, FT8/FT4 through WSJT-X, and the listed digital voice families through the integrated DSD core. RTTY, PSK, SSTV, ADS-B, DRM, and other data modes are not implemented in this build. The Kiwi view embeds the remote receiver's own interface and extensions; it is not a separate local Kiwi protocol decoder.

The RTL-SDR is receive-only here. Windows bundles its RTL-SDR driver and DSD-neo runtime. Linux packages use the pinned private RTL-SDR library for analog, HD Radio and integrated DSD-neo; USB access still follows the distribution's permission rules. WSJT-X and the optional DSD-FME selection are external programs.

## Verification and diagnostics

- `npm test` runs the directory, memory protocol and scanner regression checks. These cover phase/control decoder choices, NXDN variants, LCN preservation, selected scan groups, signal hold/resume, Skip, Stop, device errors and in-flight tuning cancellation.
- `npm run test:ui` runs Electron dialog and persistence checks using separate test memory files. Set `SDREXTREME_VERIFY_USB=1` to include a live selected-channel scan; stop reception in the main app first. The UI checks never modify the main memory library.
- `npm run diagnose:usb` opens the selected receiver briefly, receives real IQ samples, retunes, applies a supported manual gain and closes it. Stop listening in the app first so the diagnostic can claim the device.
- Desktop service output is in `local-data/desktop.log`.

## Project files

- `desktop/` — Electron desktop window, menus, native library picker and isolated remote receiver windows.
- `lib/rtl-usb.mjs`, `lib/rtl-usb-worker.mjs` — native librtlsdr bindings, USB enumeration and IQ acquisition over OS pipes.
- `lib/digital-decoder.mjs`, `lib/digital-audio.mjs` — app-managed native DSD worker, authenticated telemetry/control, call events and PCM conversion.
- `lib/decoder-spectrum.mjs`, `lib/rf-spectrum.mjs`, `lib/native-process.mjs` — native decoder IQ monitor, complex FFT, sparse buffer management and cross-platform child-process lifetime control.
- `lib/current-memory.mjs` — current receiver snapshot to a new conventional memory draft.
- `lib/hd-radio.mjs`, `lib/hd-radio-worker.mjs`, `lib/hd-options.mjs`, `hd-radio-ui.js` — HD Radio USB IQ feed, isolated nrsc5 bindings, stereo audio, broadcast metadata/artwork and station player.
- `lib/broadcast-fm.mjs`, `lib/hd-fm-worker.mjs`, `lib/hd-audio-router.mjs` — parallel FM fallback DSP, paced stereo audio queues, signal-loss switching and HD recovery.
- `lib/hd-gain.mjs`, `lib/hd-receiver-metrics.mjs`, `lib/playback-buffer.mjs` — ADC headroom gain selection, live receiver diagnostics and browser audio buffering.
- `lib/kiwi-directory.mjs`, `kiwi-network.js` — public receiver feed, saved cache, map, search, station details and favorites.
- `server.mjs` — local application service, DSP, memory store, RadioReference importer and decoder launchers.
- `index.html`, `app.css`, `app.js` — receiver workstation interface.
- `native/` — bundled Windows x64 and Linux x64 RTL-SDR and digital decoder libraries, pinned decoder source and license information.
- `launch-signal-outpost.cmd`, `setup-signal-outpost.cmd`, `stop-signal-outpost.cmd` — Windows desktop launch, setup and shutdown helpers.
- The original `launch-sdr-extreme.cmd`, `setup-sdr-extreme.cmd` and `stop-sdr-extreme.cmd` names are compatibility aliases for the renamed helpers.
