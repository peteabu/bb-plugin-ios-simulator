DRAFT — complete the pending checks and real screenshots before submission.

Adds iOS Simulator: a shared simulator panel beside a BB thread, native agent
controls, and an initial Android emulator screenshot preview.

Proposed source: https://github.com/peteabu/bb-plugin-ios-simulator.git,
Git range `^0.1.0`, release tag `v0.1.0`.

The plugin requires BB 0.46+/Plugin SDK 0.6.37+. iOS requires an Apple Silicon
Mac with Xcode, the iOS platform, and Node.js 20+. Android requires an existing
Android SDK and AVD. It runs local processes for capture/input, proxies the
panel through BB, and asks for agent control permission by default. No
additional external account or hosted service is required. The native source
and compiled helper license/provenance notices are included in the plugin.

Validated locally: current v2 entry schema, plugin ID, categories, vendored
SVG icon, and overview; full marketplace build (384 entries), v1 addition
gate, 43 marketplace tests, and upload retry tests. The plugin root reports
82 passing tests across 12 files, successful TypeScript checking, plugin
build/reload, and verified Unicode insertion in Truffle on a live iOS 27
simulator. The proposed source is unpublished (GitHub404), so source liveness cannot
pass before the approved release. The full source check covering all384
marketplace entries was stopped; it is not recorded as passed. The approved
final release commit is pending. Live Android testing is pending an SDK/AVD.

Performance was sampled under system load 26–38: static 6.7 fps/21 KiB/s;
animation 53.1 fps/136 KiB/s, median frame gap 16 ms, 90th percentile 25 ms,
and two gaps above 120 ms in eight seconds. A requested quiet-host retest has
not been performed while existing user workers remain busy.

Screenshots: PENDING real installed BB panel/header capture. Do not submit
without replacing this text and adding its entry references.

Overview source: plugin repository `PLUGIN_OVERVIEW.md`, copied unchanged to
`overview/ios-simulator.md`.
