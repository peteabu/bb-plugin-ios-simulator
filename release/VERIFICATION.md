# Local verification — 16 October 2026

## Plugin checks

- TypeScript passes. All 82 tests across 12 files pass, including native-version
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

The live bezel route returned matching local DeviceKit artwork with a 438×910
frame, a 402×874 screen at (18,18), and a 62-point corner radius. Its image route
returned valid rasterized PNG artwork. No Apple artwork is bundled.

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
