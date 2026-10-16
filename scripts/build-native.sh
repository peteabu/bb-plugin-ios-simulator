#!/bin/bash
# Rebuild serve-sim's native capture module with the plugin's framebuffer
# polling patch (native/serve-sim/Sources/SimNative/FrameCapture.swift) and
# place it at native/serve-sim-native.node, which server.ts installs over the
# dependency's copy at load. Needs Apple Silicon, Xcode (Swift 6), and network
# for the locked npm and SwiftPM dependencies. See native/serve-sim/PROVENANCE.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$HERE/native/serve-sim"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "The bundled capture module must be built on an Apple Silicon Mac." >&2
  exit 1
fi
npm ci --ignore-scripts --prefix "$PKG" --cache "$HERE/native/.npm-cache"
MC="$HERE/native/.modcache"
mkdir -p "$MC"
# SwiftPM compiles manifests before applying target flags. Keep their module
# cache in the same writable build directory as the target's cache.
export CLANG_MODULE_CACHE_PATH="$MC"
export SWIFTPM_MODULECACHE_OVERRIDE="$MC"
BUILD_FLAGS=(
  -c release --product serve-sim-native --package-path "$PKG"
  --scratch-path "$HERE/native/.build" --cache-path "$HERE/native/.cache"
  --config-path "$HERE/native/.swiftpm-config" --security-path "$HERE/native/.swiftpm-security"
  --build-system swiftbuild --arch arm64
  -Xswiftc -module-cache-path -Xswiftc "$MC" -Xcc -fmodules-cache-path="$MC"
)
swift build "${BUILD_FLAGS[@]}"
DYLIB="$(swift build --show-bin-path "${BUILD_FLAGS[@]}")/libserve-sim-native.dylib"
[ -f "$DYLIB" ] || { echo "build product not found" >&2; exit 1; }
cp -f "$DYLIB" "$HERE/native/serve-sim-native.node"
strip -x "$HERE/native/serve-sim-native.node"
codesign -s - -f "$HERE/native/serve-sim-native.node"
echo "Built $HERE/native/serve-sim-native.node"
