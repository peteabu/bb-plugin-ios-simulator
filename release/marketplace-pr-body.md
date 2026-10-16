Adds iOS Simulator: a shared simulator panel beside a BB thread, native agent
controls, and an initial Android emulator screenshot preview.

Source: https://github.com/peteabu/bb-plugin-ios-simulator.git,
Git range `^0.1.0`, immutable release tag `v0.1.0`.

Plugin checks pass: **110 tests across 14 files**, TypeScript, BB plugin
build, and reload. Native BB Home, Lock, full-cycle toolbar rotation, and
explicit attachment/default selection pass live checks. Foreground pointer
actions reach the expected asymmetric targets in portrait and both landscape
orientations. A 90-second H.264 run decoded **546/546 frames without errors**
including the Lock transition. Unicode text insertion was verified in Truffle.
Android caller cancellation preserves a concurrent shared screenshot; live
Android testing still needs an SDK/AVD.

Marketplace checks pass: current v2 schema, ID/categories, icon/image hashes,
PNG format/width/size, no orphan screenshots, overview and draft-copy equality,
full build (384 entries), v1 addition gate, all 43 tests, upload retry tests,
and whitespace. One unchanged entry has an unrelated missing-category warning.

The plugin requires BB 0.46+/Plugin SDK 0.6.37+. iOS requires an Apple Silicon
Mac with Xcode, the iOS platform, and Node.js 20+. Android requires an existing
Android SDK and AVD. Local helpers capture and control the device; BB proxies
the panel and asks for agent control permission by default. No additional
external account or hosted service is required. Native source/binary licenses
and provenance are included; Xcode artwork is read locally, not bundled.

`screenshots/ios-simulator/panel-eb92b3d6.png` shows the real installed BB panel
with Truffle's Create conversation/Wikipedia topics, local Apple device frame,
picker, and footer controls. The reviewed native-window crop is 1472×1600 and
278,376 bytes, without private chat or paths. It remains accurate after the
final fixes. The full private window capture is excluded.

Performance samples were taken under heavy host load. Historical animation
was 53.1 fps at load 26–38, with two gaps above 120 ms in eight seconds.
A separate-device run measured 47.7 fps, median gap 17 ms/p90 30 ms, and two
gaps above 120 ms; idle was 2.5 fps. Host load was about 657 before and 159
after that run. These do not establish quiet- or normal-host performance;
the requested quiet-host retest remains unfulfilled.

Overview source: plugin repository `PLUGIN_OVERVIEW.md`, copied unchanged to
`overview/ios-simulator.md`.
