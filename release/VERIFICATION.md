# Local verification — 16 October 2026

## Plugin checks

- TypeScript passes. All 94 tests across 13 files pass, including native-version
  guards, consent, device ownership, input cancellation, clipboard failure,
  concurrent text, Android boot identity, and UI geometry/controls.
- `bb plugin build` succeeds. The path-installed plugin reloads and restores
  the attached iOS stream.
- `serve-sim` is pinned to 0.1.48 in both package manifests. The vendored capture
  module is installed only into that exact dependency version.
- Both bundled native binaries were rebuilt, signed, and checked against
  `native/BUILD_METADATA.json`. Source, build manifests, and license notices
  are included; build caches and Apple artwork are excluded from Git.

## Real iOS app loop

The existing Truffle project was built with Xcode 27 for the attached iPhone
simulator using `xcodebuild -project …/Truffle.xcodeproj -scheme Truffle
-destination 'platform=iOS Simulator,id=…' -derivedDataPath … -configuration
Debug CODE_SIGNING_ALLOWED=NO build`. Build succeeded.

The plugin installed and launched the resulting app. Screenshots showed its
home screen; coordinate taps opened its search. The plugin's paste RPC inserted
“Café 東京” into that real field, and a screenshot showed the query and matching
search results. The UIKit helper also passed three byte-for-byte pasteboard
round trips containing Unicode, line breaks, tabs, and emoji. Every clipboard
write is read back before sending Command-V; a silent failed write is an error.

The corrected live bezel route returns Apple's 436×908 composite body with a
402×874 screen at (17,17). The body is rasterized from its vector PDF at 3×
(1308×2724); the native framebuffer alpha mask is 1206×2622 and is rendered
separately for all four orientations. This replaces inferred nine-slice sizing,
72dpi artwork, and a circular CSS screen crop. No Apple artwork is bundled.

## Frame, toolbar, and viewer follow-up

- Live button RPC response time measured 74.4 ms before and 3.2 ms after the
  persistent HID connection change. The previous fixed waits were 70 ms per
  button and 110 ms per rotation. These measurements cover dispatch, not the
  simulator's animation completion or browser input-to-paint latency.
- Toolbar controls have pending feedback and keep their layout independent of
  changing video statistics. Repeated rotations advance from the last requested
  orientation while the simulator's configuration catches up.
- The viewer uses composited canvas painting with high-quality scaling. On
  disconnect it closes its decoder, frame handles, timers, and transport before
  reconnecting; late frames cannot paint after disposal.
- Fitness flicker was independently reproduced in 12 `simctl` screenshots as
  well as 108 MJPEG frames. The Fitness+ card alternates loading placeholders
  and Content Unavailable before the plugin viewer. Relaunching Fitness still
  showed a loading error. No native capture modification was justified; the
  underlying Fitness/Xcode cause remains undetermined.
- Geometry, raster dimensions, alpha edges, rotation, lifecycle, and controls
  were checked through native output, HTTP, and the SDK test harness. Native
  BB-window visual inspection remains blocked by Computer Use approval; no
  claim is made that its final on-screen appearance was visually verified.

## Stream measurement

A local Safari page synchronized static and animated phases with a temporary
benchmark server. Samples counted H.264 records delivered by serve-sim; these
are transport measurements, not BB renderer paint rate or tap latency.

| Scene | Sample | Frames/s | KiB/s | Median frame gap | 90th percentile |
| --- | --- | --- | --- | --- | --- |
| Static page | 6 seconds | 6.7 | 21 | 206 ms | 224 ms |
| CSS animation | 8 seconds | 53.1 | 136 | 16 ms | 25 ms |

The animation sample had two gaps over 120 ms. Longer idle gaps are expected
at the helper's five-frame-per-second idle floor. The Mac's load average was
26–38, with seven aligner workers consuming most CPU cores. A quiet-machine
comparison remains pending; unrelated workers were left running.

## Remaining limits

- Xcode 27's accessibility service returned `noFrontmostApplication` while
  Truffle was visibly running and touchable. Read-only probes confirmed normal
  bridge callbacks but empty results for both tested display IDs and client
  types. The tool reports this and directs agents to screenshot/coordinate
  controls. Accessibility-based tapping was not verified successfully.
- No Android SDK or AVD is installed on this host. Android's 17 automated
  checks pass and the live readiness RPC reports missing tools, but real
  Android boot/install/input/preview remain unverified. Its preview uses
  serialized PNG polling at about one frame per second.
- Computer Use was not approved to access bb. Header/control behavior and frame
  geometry were verified with the SDK harness and backend, but a native BB
  screenshot and visual review remain pending. The marketplace draft has no
  screenshots and must not be submitted in that state.
- No public repository, release tag, or marketplace pull request has been
  published. See RELEASE_PLAN.md for the proposed release and approval steps.
