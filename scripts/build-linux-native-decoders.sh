#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
HD_SOURCE_ARCHIVE="$ROOT_DIR/native/hd-radio/source/nrsc5-3.2.0.zip"
DSD_SOURCE_ARCHIVE="$ROOT_DIR/native/digital/source/dsd-neo-32ae7c8.zip"
HD_MANIFEST="$ROOT_DIR/native/hd-radio/manifest.json"
DSD_MANIFEST="$ROOT_DIR/native/digital/manifest.json"
HD_RUNTIME="$ROOT_DIR/native/hd-radio/linux-x64"
DSD_RUNTIME="$ROOT_DIR/native/digital/linux-x64"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "The bundled decoder build currently targets Linux x86_64." >&2
  exit 2
fi
for tool in cmake ninja pkg-config git unzip sha256sum ldd readelf; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing build tool: $tool" >&2; exit 2; }
done

source_archive_hash() {
  node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).sourceArchiveSha256)' "$1"
}
verify_archive() {
  local archive=$1 expected=$2 actual
  actual="$(sha256sum -- "$archive" | cut -d ' ' -f 1)"
  if [[ "$actual" != "$expected" ]]; then
    echo "Pinned decoder source archive hash mismatch: $archive" >&2
    exit 1
  fi
}

verify_archive "$HD_SOURCE_ARCHIVE" "$(source_archive_hash "$HD_MANIFEST")"
verify_archive "$DSD_SOURCE_ARCHIVE" "$(source_archive_hash "$DSD_MANIFEST")"

# The only paths removed are the two generated Linux runtime directories.
if [[ "$HD_RUNTIME" != "$ROOT_DIR/native/hd-radio/linux-x64" || "$DSD_RUNTIME" != "$ROOT_DIR/native/digital/linux-x64" ]]; then
  echo "Refusing to replace an unexpected native runtime path." >&2
  exit 1
fi
rm -rf -- "$HD_RUNTIME" "$DSD_RUNTIME"
mkdir -p "$HD_RUNTIME/lib" "$DSD_RUNTIME/lib" "$DSD_RUNTIME/bin"

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/signal-outpost-native.XXXXXXXX")"
trap 'rm -rf -- "$BUILD_ROOT"' EXIT
JOBS="${SDR_EXTREME_NATIVE_JOBS:-2}"

unzip -q "$HD_SOURCE_ARCHIVE" -d "$BUILD_ROOT/nrsc5-source"
unzip -q "$DSD_SOURCE_ARCHIVE" -d "$BUILD_ROOT/dsd-source"
NRSC5_SOURCE="$(find "$BUILD_ROOT/nrsc5-source" -mindepth 1 -maxdepth 1 -type d -name 'nrsc5-*' -print -quit)"
DSD_SOURCE="$(find "$BUILD_ROOT/dsd-source" -mindepth 1 -maxdepth 1 -type d -name 'dsd-neo-*' -print -quit)"
[[ -n "$NRSC5_SOURCE" && -n "$DSD_SOURCE" ]] || { echo "Could not locate the pinned decoder source trees." >&2; exit 1; }
node "$ROOT_DIR/scripts/apply-dsd-neo-source-patches.mjs" "$DSD_SOURCE"

# DSD-neo's pinned dependency file supplies the V4-capable RTL-SDR and codec
# commits. Building them beside the app keeps the runtime independent of an
# installed system RTL-SDR or mbelib version.
# shellcheck source=/dev/null
source "$DSD_SOURCE/tools/ci-dependency-pins.env"
"$DSD_SOURCE/tools/fetch-pinned-git.sh" https://github.com/arancormonk/rtl-sdr "$RTL_SDR_SHA" "$BUILD_ROOT/rtl-sdr"
"$DSD_SOURCE/tools/fetch-pinned-git.sh" https://github.com/arancormonk/mbelib-neo "$MBELIB_NEO_SHA" "$BUILD_ROOT/mbelib-neo"

cmake -S "$BUILD_ROOT/rtl-sdr" -B "$BUILD_ROOT/rtl-sdr-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$DSD_RUNTIME" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_INSTALL_RPATH='$ORIGIN' \
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
  -DCMAKE_INSTALL_RPATH='$ORIGIN'
cmake --build "$BUILD_ROOT/mbelib-build" --target mbe-shared mbe-static --parallel "$JOBS"
cmake --install "$BUILD_ROOT/mbelib-build"

export PKG_CONFIG_PATH="$DSD_RUNTIME/lib/pkgconfig:$DSD_RUNTIME/lib/x86_64-linux-gnu/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export CMAKE_PREFIX_PATH="$DSD_RUNTIME${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
export LD_LIBRARY_PATH="$DSD_RUNTIME/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# The app consumes PCM and telemetry itself; no terminal UI or device audio
# backend is needed inside this supervised decoder process.
cmake -S "$DSD_SOURCE" -B "$BUILD_ROOT/dsd-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$DSD_RUNTIME" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_INSTALL_RPATH='$ORIGIN/../lib' \
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
if [[ ! -f "$DSD_EXECUTABLE" ]]; then
  echo "DSD-neo install did not produce $DSD_EXECUTABLE" >&2
  exit 1
fi
chmod 755 "$DSD_EXECUTABLE"
bundle_dependencies() {
  local library_dir=$1
  shift
  local -a queue=("$@")
  local -A visited=()
  local current output dep base target source_real target_real owner package legal_dir
  local i=0
  while (( i < ${#queue[@]} )); do
    current="${queue[$i]}"
    ((i += 1))
    source_real="$(readlink -f -- "$current")"
    [[ -n "$source_real" && -z "${visited[$source_real]+x}" ]] || continue
    visited["$source_real"]=1
    output="$(ldd "$current")" || { echo "Could not inspect native dependency closure: $current" >&2; return 1; }
    if grep -q '=> not found' <<<"$output"; then
      echo "Unresolved native dependency for $current:" >&2
      grep '=> not found' <<<"$output" >&2
      return 1
    fi
    while IFS= read -r dep; do
      [[ -n "$dep" && -e "$dep" ]] || continue
      base="$(basename -- "$dep")"
      case "$base" in
        linux-vdso.so.*|libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|libresolv.so.*|libnss_*.so.*|ld-linux*.so.*) continue ;;
      esac
      target="$library_dir/$base"
      source_real="$(readlink -f -- "$dep")"
      if [[ -e "$target" ]]; then
        target_real="$(readlink -f -- "$target")"
        if [[ "$source_real" != "$target_real" ]]; then
          echo "Two runtime libraries have the same loader name: $base" >&2
          return 1
        fi
      else
        cp -L -- "$dep" "$target"
        chmod 755 "$target"
        queue+=("$target")
        if command -v dpkg-query >/dev/null 2>&1; then
          owner="$(dpkg-query -S "$source_real" 2>/dev/null | head -n 1 || true)"
          package="${owner%%:*}"
          if [[ -n "$package" && -f "/usr/share/doc/$package/copyright" ]]; then
            legal_dir="$DSD_RUNTIME/share/doc/third-party"
            mkdir -p "$legal_dir"
            cp -n "/usr/share/doc/$package/copyright" "$legal_dir/$package.copyright" 2>/dev/null || true
          fi
        fi
      fi
    done < <(awk '/=> \/[^ ]+/ { print $3 } /^[[:space:]]*\// { print $1 }' <<<"$output")
  done
}

mapfile -t DSD_LIBRARIES < <(find "$DSD_RUNTIME/lib" -type f -name '*.so*' -print)
bundle_dependencies "$DSD_RUNTIME/lib" "$DSD_EXECUTABLE" "${DSD_LIBRARIES[@]}"

NRSC5_BUILD="$BUILD_ROOT/nrsc5-build"
cmake -S "$NRSC5_SOURCE" -B "$NRSC5_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$HD_RUNTIME" \
  -DBUILD_CLI=OFF \
  -DUSE_FAAD2=ON \
  -DUSE_SYSTEM_FFTW=ON \
  -DUSE_SYSTEM_RTLSDR=ON \
  -DUSE_SYSTEM_LIBUSB=ON \
  -DUSE_SYSTEM_LIBAO=ON \
  -DCMAKE_PREFIX_PATH="$DSD_RUNTIME"
cmake --build "$NRSC5_BUILD" --target faad2_external --parallel "$JOBS"
cmake --build "$NRSC5_BUILD" --target nrsc5 --parallel "$JOBS"
NRSC5_LIBRARY="$(find "$NRSC5_BUILD" -type f -name 'libnrsc5.so*' -print -quit)"
[[ -n "$NRSC5_LIBRARY" ]] || { echo "nrsc5 build did not produce libnrsc5.so." >&2; exit 1; }
cp -L -- "$NRSC5_LIBRARY" "$HD_RUNTIME/lib/libnrsc5.so"
RTLSDR_RUNTIME="$(find "$DSD_RUNTIME/lib" -maxdepth 1 -type f -name 'librtlsdr.so.*' -print -quit)"
[[ -n "$RTLSDR_RUNTIME" ]] || { echo "Bundled librtlsdr runtime was not found." >&2; exit 1; }
RTLSDR_SONAME="$(objdump -p "$RTLSDR_RUNTIME" | awk '$1 == "SONAME" { print $2; exit }')"
[[ -n "$RTLSDR_SONAME" ]] || { echo "Could not read bundled librtlsdr SONAME." >&2; exit 1; }
cp -L -- "$RTLSDR_RUNTIME" "$HD_RUNTIME/lib/$RTLSDR_SONAME"
# Give the direct receiver a stable path to the same V4-compatible driver.
# The original SONAME files remain in place for the integrated decoder's loader.
cp -L -- "$RTLSDR_RUNTIME" "$DSD_RUNTIME/lib/librtlsdr-app.so"
chmod 755 "$DSD_RUNTIME/lib/librtlsdr-app.so"
LD_LIBRARY_PATH="$HD_RUNTIME/lib" bundle_dependencies "$HD_RUNTIME/lib" "$HD_RUNTIME/lib/libnrsc5.so"

# Keep the RTL-SDR headers and pkg-config metadata available until nrsc5 has
# finished compiling against the same pinned librtlsdr. They are build inputs,
# not runtime files, so remove them from the shipped app afterward.
rm -rf -- "$DSD_RUNTIME/include" "$DSD_RUNTIME/lib/cmake" "$DSD_RUNTIME/lib/pkgconfig"
rm -f -- "$DSD_RUNTIME/bin/rtl_adsb" "$DSD_RUNTIME/bin/rtl_biast" "$DSD_RUNTIME/bin/rtl_eeprom" \
  "$DSD_RUNTIME/bin/rtl_fm" "$DSD_RUNTIME/bin/rtl_power" "$DSD_RUNTIME/bin/rtl_sdr" \
  "$DSD_RUNTIME/bin/rtl_tcp" "$DSD_RUNTIME/bin/rtl_test" "$DSD_RUNTIME/lib/"*.a

# Keep upstream legal material and the matching USB permission rule available
# with the Linux decoder package. The app never installs udev rules itself.
mkdir -p "$DSD_RUNTIME/share/doc/third-party"
if [[ -f "$BUILD_ROOT/rtl-sdr/COPYING" ]]; then
  cp "$BUILD_ROOT/rtl-sdr/COPYING" "$DSD_RUNTIME/share/doc/third-party/rtl-sdr-COPYING"
fi
for rules in "$BUILD_ROOT/rtl-sdr/rtl-sdr.rules" "$BUILD_ROOT/rtl-sdr/rtl-sdr.rules.in"; do
  if [[ -f "$rules" ]]; then cp "$rules" "$DSD_RUNTIME/share/doc/third-party/rtl-sdr.rules"; break; fi
done
find "$BUILD_ROOT/mbelib-neo" -maxdepth 2 -type f \( -iname 'license' -o -iname 'copying' -o -iname 'notice*' \) \
  -exec cp -n '{}' "$DSD_RUNTIME/share/doc/third-party/" \; 2>/dev/null || true

# electron-builder copies app files concurrently and can race while following
# chained shared-library symlinks. Preserve every loader name as a real file.
materialize_runtime_symlinks() {
  local runtime_dir=$1 link resolved temporary
  while IFS= read -r -d '' link; do
    resolved="$(readlink -f -- "$link")"
    [[ -n "$resolved" && -f "$resolved" ]] || { echo "Broken native runtime symlink: $link" >&2; return 1; }
    temporary="${link}.materialized"
    cp -L -- "$link" "$temporary"
    chmod 755 "$temporary"
    mv -f -- "$temporary" "$link"
  done < <(find "$runtime_dir" -type l -print0)
}
materialize_runtime_symlinks "$DSD_RUNTIME"
materialize_runtime_symlinks "$HD_RUNTIME"

for binary in "$DSD_EXECUTABLE" "$HD_RUNTIME/lib/libnrsc5.so"; do
  if readelf -h "$binary" | grep -q 'Class:.*ELF64' && readelf -h "$binary" | grep -q 'Machine:.*X86-64'; then
    :
  else
    echo "Unexpected Linux native binary architecture: $binary" >&2
    exit 1
  fi
done

node "$ROOT_DIR/scripts/record-linux-native-manifests.mjs"
echo "Built the pinned Linux x86_64 HD Radio and DSD-neo runtimes."
