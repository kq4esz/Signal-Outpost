#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
HD_SOURCE_ARCHIVE="$ROOT_DIR/native/hd-radio/source/nrsc5-3.2.0.zip"
DSD_SOURCE_ARCHIVE="$ROOT_DIR/native/digital/source/dsd-neo-32ae7c8.zip"
HD_MANIFEST="$ROOT_DIR/native/hd-radio/manifest.json"
DSD_MANIFEST="$ROOT_DIR/native/digital/manifest.json"
HOST_MACHINE="$(uname -m)"
case "$HOST_MACHINE" in
  arm64) HOST_ARCH=arm64 ;;
  x86_64) HOST_ARCH=x64 ;;
  *) echo "Unsupported macOS build architecture: $HOST_MACHINE" >&2; exit 2 ;;
esac
ARCH="${SDR_EXTREME_MAC_ARCH:-$HOST_ARCH}"
if [[ "$ARCH" != "$HOST_ARCH" ]]; then
  echo "Build the native macOS runtime on a matching $ARCH runner (current runner: $HOST_ARCH)." >&2
  exit 2
fi

HD_RUNTIME="$ROOT_DIR/native/hd-radio/darwin-$ARCH"
DSD_RUNTIME="$ROOT_DIR/native/digital/darwin-$ARCH"
for tool in cmake ninja pkg-config git unzip shasum otool install_name_tool file brew; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing macOS build tool: $tool" >&2; exit 2; }
done

source_archive_hash() {
  node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).sourceArchiveSha256)' "$1"
}
verify_archive() {
  local archive=$1 expected=$2 actual
  actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Pinned decoder source archive hash mismatch: $archive" >&2
    exit 1
  fi
}
verify_archive "$HD_SOURCE_ARCHIVE" "$(source_archive_hash "$HD_MANIFEST")"
verify_archive "$DSD_SOURCE_ARCHIVE" "$(source_archive_hash "$DSD_MANIFEST")"

# Remove only generated runtimes for the architecture this runner is building.
if [[ "$HD_RUNTIME" != "$ROOT_DIR/native/hd-radio/darwin-$ARCH" || "$DSD_RUNTIME" != "$ROOT_DIR/native/digital/darwin-$ARCH" ]]; then
  echo "Refusing to replace an unexpected native runtime path." >&2
  exit 1
fi
rm -rf "$HD_RUNTIME" "$DSD_RUNTIME"
mkdir -p "$HD_RUNTIME/lib" "$DSD_RUNTIME/lib" "$DSD_RUNTIME/bin"

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/signal-outpost-macos-native.XXXXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT
JOBS="${SDR_EXTREME_NATIVE_JOBS:-2}"
BREW_PREFIX="$(brew --prefix)"
export PKG_CONFIG_PATH="$DSD_RUNTIME/lib/pkgconfig:$BREW_PREFIX/lib/pkgconfig:$BREW_PREFIX/opt/libusb/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export CMAKE_PREFIX_PATH="$DSD_RUNTIME:$BREW_PREFIX${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
MAC_BREW_RPATH="@loader_path;$BREW_PREFIX/lib;$BREW_PREFIX/opt/libusb/lib;$BREW_PREFIX/opt/fftw/lib;$BREW_PREFIX/opt/libsndfile/lib"

unzip -q "$HD_SOURCE_ARCHIVE" -d "$BUILD_ROOT/nrsc5-source"
unzip -q "$DSD_SOURCE_ARCHIVE" -d "$BUILD_ROOT/dsd-source"
NRSC5_SOURCE="$BUILD_ROOT/nrsc5-source/nrsc5-3.2.0"
DSD_SOURCE="$BUILD_ROOT/dsd-source/dsd-neo-32ae7c8afba7bb8acbc95d1c6b4099db48d899a0"
[[ -n "$NRSC5_SOURCE" && -n "$DSD_SOURCE" ]] || { echo "Could not locate the pinned decoder source trees." >&2; exit 1; }

# Build the same pinned, Blog V4-capable RTL-SDR source and codec dependency
# used by Linux; the app and both decoders share this private macOS driver.
# shellcheck source=/dev/null
source "$DSD_SOURCE/tools/ci-dependency-pins.env"
"$DSD_SOURCE/tools/fetch-pinned-git.sh" https://github.com/arancormonk/rtl-sdr "$RTL_SDR_SHA" "$BUILD_ROOT/rtl-sdr"
"$DSD_SOURCE/tools/fetch-pinned-git.sh" https://github.com/arancormonk/mbelib-neo "$MBELIB_NEO_SHA" "$BUILD_ROOT/mbelib-neo"

cmake -S "$BUILD_ROOT/rtl-sdr" -B "$BUILD_ROOT/rtl-sdr-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$DSD_RUNTIME" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_INSTALL_RPATH="$MAC_BREW_RPATH" \
  -DCMAKE_INSTALL_NAME_DIR='@rpath' \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DINSTALL_UDEV_RULES=OFF \
  -DDETACH_KERNEL_DRIVER=ON
cmake --build "$BUILD_ROOT/rtl-sdr-build" --parallel "$JOBS"
cmake --install "$BUILD_ROOT/rtl-sdr-build"

cmake -S "$BUILD_ROOT/mbelib-neo" -B "$BUILD_ROOT/mbelib-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTING=OFF \
  -DBUILD_SHARED_LIBS=ON \
  -DCMAKE_INSTALL_PREFIX="$DSD_RUNTIME" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_INSTALL_RPATH="$MAC_BREW_RPATH"
cmake --build "$BUILD_ROOT/mbelib-build" --target mbe-shared mbe-static --parallel "$JOBS"
cmake --install "$BUILD_ROOT/mbelib-build"

export DYLD_LIBRARY_PATH="$DSD_RUNTIME/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
cmake -S "$DSD_SOURCE" -B "$BUILD_ROOT/dsd-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$DSD_RUNTIME" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_INSTALL_RPATH="@loader_path/../lib;$BREW_PREFIX/lib;$BREW_PREFIX/opt/libusb/lib;$BREW_PREFIX/opt/fftw/lib;$BREW_PREFIX/opt/libsndfile/lib" \
  -DCMAKE_INSTALL_NAME_DIR='@rpath' \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DCMAKE_PREFIX_PATH="$DSD_RUNTIME;$BREW_PREFIX" \
  -DRTLSDR_ROOT="$DSD_RUNTIME" \
  -DBUILD_TESTING=OFF \
  -DDSD_ENABLE_API=ON \
  -DDSD_ENABLE_RTLSDR=ON \
  -DDSD_REQUIRE_RTLSDR=ON \
  -DDSD_ENABLE_AIRSPY=OFF \
  -DDSD_ENABLE_SOAPYSDR=OFF \
  -DDSD_ENABLE_TERMINAL_UI=OFF \
  -DDSD_AUDIO_BACKEND=none \
  -DDSD_ENABLE_LTO=ON \
  -DDSD_ENABLE_FAST_MATH=ON \
  -DDSD_WARNINGS_AS_ERRORS=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_CODEC2=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_EXPAT=ON
cmake --build "$BUILD_ROOT/dsd-build" --parallel "$JOBS"
cmake --install "$BUILD_ROOT/dsd-build"

DSD_EXECUTABLE="$DSD_RUNTIME/bin/dsd-neo"
[[ -f "$DSD_EXECUTABLE" ]] || { echo "DSD-neo install did not produce $DSD_EXECUTABLE" >&2; exit 1; }
chmod 755 "$DSD_EXECUTABLE"

cmake -S "$NRSC5_SOURCE" -B "$BUILD_ROOT/nrsc5-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$HD_RUNTIME" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_INSTALL_RPATH="$MAC_BREW_RPATH" \
  -DCMAKE_INSTALL_NAME_DIR='@rpath' \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DBUILD_CLI=OFF \
  -DUSE_FAAD2=ON \
  -DUSE_SYSTEM_FFTW=ON \
  -DUSE_SYSTEM_RTLSDR=ON \
  -DUSE_SYSTEM_LIBUSB=ON \
  -DUSE_SYSTEM_LIBAO=ON \
  -DCMAKE_PREFIX_PATH="$DSD_RUNTIME;$BREW_PREFIX"
cmake --build "$BUILD_ROOT/nrsc5-build" --target faad2_external --parallel "$JOBS"
cmake --build "$BUILD_ROOT/nrsc5-build" --target nrsc5 --parallel "$JOBS"
NRSC5_LIBRARY="$(find "$BUILD_ROOT/nrsc5-build" -type f -name 'libnrsc5*.dylib' -print -quit)"
[[ -n "$NRSC5_LIBRARY" ]] || { echo "nrsc5 build did not produce a macOS dylib." >&2; exit 1; }
cp -L "$NRSC5_LIBRARY" "$HD_RUNTIME/lib/libnrsc5.dylib"
ditto "$DSD_RUNTIME/lib" "$HD_RUNTIME/lib"

materialize_runtime_symlinks() {
  local runtime_dir=$1 link resolved temporary
  while IFS= read -r -d '' link; do
    resolved="$(realpath "$link")"
    [[ -n "$resolved" && -f "$resolved" ]] || { echo "Broken native runtime symlink: $link" >&2; return 1; }
    temporary="${link}.materialized"
    cp -L "$link" "$temporary"
    chmod 755 "$temporary"
    mv -f "$temporary" "$link"
  done < <(find "$runtime_dir" -type l -print0)
}
materialize_runtime_symlinks "$DSD_RUNTIME"
materialize_runtime_symlinks "$HD_RUNTIME"
RTLSDR_LIBRARY="$(find "$DSD_RUNTIME/lib" -type f -name 'librtlsdr*.dylib' -print -quit)"
[[ -n "$RTLSDR_LIBRARY" ]] || { echo "Bundled librtlsdr runtime was not found." >&2; exit 1; }
cp -L "$RTLSDR_LIBRARY" "$DSD_RUNTIME/lib/librtlsdr-app.dylib"
chmod 755 "$DSD_RUNTIME/lib/librtlsdr-app.dylib"

node "$ROOT_DIR/scripts/bundle-macos-libraries.mjs" "$DSD_RUNTIME" bin/dsd-neo lib/librtlsdr-app.dylib
node "$ROOT_DIR/scripts/bundle-macos-libraries.mjs" "$HD_RUNTIME" lib/libnrsc5.dylib

rm -rf "$DSD_RUNTIME/include" "$DSD_RUNTIME/lib/cmake" "$DSD_RUNTIME/lib/pkgconfig"
rm -f "$DSD_RUNTIME/bin/rtl_adsb" "$DSD_RUNTIME/bin/rtl_biast" "$DSD_RUNTIME/bin/rtl_eeprom" \
  "$DSD_RUNTIME/bin/rtl_fm" "$DSD_RUNTIME/bin/rtl_power" "$DSD_RUNTIME/bin/rtl_sdr" \
  "$DSD_RUNTIME/bin/rtl_tcp" "$DSD_RUNTIME/bin/rtl_test" "$DSD_RUNTIME/lib/"*.a

mkdir -p "$DSD_RUNTIME/share/doc/third-party" "$DSD_RUNTIME/share/doc/dsd-neo"
find "$DSD_SOURCE" -type f \( -iname 'license*' -o -iname 'copying*' -o -iname 'notice*' \) \
  -exec cp -n '{}' "$DSD_RUNTIME/share/doc/dsd-neo/" \; 2>/dev/null || true
if [[ -f "$BUILD_ROOT/rtl-sdr/COPYING" ]]; then cp -n "$BUILD_ROOT/rtl-sdr/COPYING" "$DSD_RUNTIME/share/doc/third-party/rtl-sdr-COPYING"; fi
find "$BUILD_ROOT/mbelib-neo" -type f \( -iname 'license' -o -iname 'copying' -o -iname 'notice*' \) \
  -exec cp -n '{}' "$DSD_RUNTIME/share/doc/third-party/" \; 2>/dev/null || true
[[ -f "$NRSC5_SOURCE/COPYING" ]] && cp "$NRSC5_SOURCE/COPYING" "$HD_RUNTIME/COPYING.GPL-3.0"

DSD_ARCH="$(file -b "$DSD_EXECUTABLE")"
HD_ARCH="$(file -b "$HD_RUNTIME/lib/libnrsc5.dylib")"
case "$ARCH:$DSD_ARCH:$HD_ARCH" in
  x64:*x86_64*:*) ;;
  arm64:*arm64*:*) ;;
  *) echo "Unexpected macOS runtime architecture for $ARCH: DSD=$DSD_ARCH HD=$HD_ARCH" >&2; exit 1 ;;
esac

node "$ROOT_DIR/scripts/record-macos-native-manifests.mjs" "$ARCH"
echo "Built pinned macOS $ARCH HD Radio, DSD-neo, and RTL-SDR runtimes."
