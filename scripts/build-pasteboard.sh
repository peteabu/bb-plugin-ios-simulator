#!/bin/bash
# Build the UIKit command-line helper that writes the simulator pasteboard.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "The bundled pasteboard helper must be built on an Apple Silicon Mac." >&2
  exit 1
fi
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
CACHE="$HERE/native/.modcache"
mkdir -p "$CACHE"
xcrun --sdk iphonesimulator swiftc "$HERE/native/Pasteboard.swift" \
  -O -target arm64-apple-ios15.0-simulator -sdk "$SDK" \
  -module-cache-path "$CACHE" -o "$HERE/native/simulator-pasteboard"
codesign -s - -f "$HERE/native/simulator-pasteboard"
echo "Built $HERE/native/simulator-pasteboard"
