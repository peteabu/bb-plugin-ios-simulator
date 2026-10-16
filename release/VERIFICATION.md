# Local verification — 16 October 2026

## Plugin checks

- All **110 tests across 14 files** pass. Coverage includes stream/decoder
  disposal, consent, device ownership, clipboard failure and Unicode input,
  Android lifecycle/cancellation, explicit device selection, all four frame
  rotations, and pointer mapping with asymmetric geometry.
- `npm run typecheck`, `npm run build` (`bb plugin build`), and
  `git diff --check` pass. The path-installed plugin reloads successfully.
- `serve-sim` is pinned to 0.1.48 in manifest and lockfile. The native capture
  module is installed only into that exact dependency version.
- Both tracked native binary hashes match `native/BUILD_METADATA.json`.
  Source, reproduction scripts, provenance, and license notices are included.
  Build caches and Apple artwork are excluded from Git.

## Real iOS app and panel

The existing Truffle project built successfully with Xcode 27 using
`xcodebuild` and an explicit iOS Simulator destination. The plugin installed
and launched the app. Taps opened search, and paste inserted “Café 東京”;
a screenshot showed the query and matching results. The UIKit clipboard
helper also passed three exact Unicode/multiline/emoji round trips. Clipboard
writes are read back before Command-V so a silent failed write is an error.

Native BB window captures through the user-configured Cua Driver confirm the
real installed panel's portrait frame, picker, stream, and footer controls.
The marketplace contains only a reviewed panel crop, without private chat or
paths: `panel-eb92b3d6.png`, 1472×1600, 278,376 bytes. Its portrait appearance
remains accurate after the final selection/rotation fixes.

Apple's local DeviceKit artwork provides a 436×908 body and a 402×874 opening
at (17,17). Vector artwork is rasterized at 3× (1308×2724); the framebuffer
mask is 1206×2622, with separate masks for four orientations. No Apple artwork
is bundled. This replaces inferred nine-slice sizing and 72dpi rasterization.

Final live checks used a separate iPhone 17 Pro simulator so another thread's
device was not driven. Explicit attach selected that device in the panel.
Home and Lock worked through the actual footer buttons. Toolbar rotation
completed a full cycle and returned to an upright portrait view; both
landscape directions displayed the matching frame and normalized content.
Foreground pointer clicks reached distinct page targets in portrait, landscape
left, and landscape right, verified by both visible feedback and HTTP events.
The page's Safari orientation policy governs its response to upside-down
orientation; automated geometry tests cover that physical rotation too.

## Responsiveness and stream lifecycle

- Persistent HID dispatch reduced measured button RPC response from 74.4 ms
  to 3.2 ms. These numbers measure dispatch, not animation completion or
  browser input-to-paint latency.
- Controls show per-button pending feedback. The statistics row has fixed
  space so changing video statistics do not shift the buttons.
- Explicit attach promotes and persists the requested default device and
  selects it in mounted panels. Ordinary operations preserve selection.
- Raw portrait frames are normalized for landscape display, and pointer
  begin/move/end coordinates receive the corresponding inverse transform.
  Already-landscape frames skip the quarter-turn transform.
- Canvas painting uses high-quality scaling. Disconnect closes the decoder,
  pending frames, timers, and transport; late frames cannot paint after
  disposal. No native encoder change was made for an unproven freeze.
- A 90-second persistent H.264 connection decoded **546/546 frames with zero
  errors**, including the Lock transition before the next keyframe. A final
  native BB capture also showed Lock correctly after the toolbar action.
  The earlier delayed display did not reproduce as a persistent freeze.
- Android screenshot coalescing now lets a cancelled caller stop its own wait
  without aborting another caller's shared adb capture. Service disposal still
  aborts the underlying capture.

## Fitness flicker

Flicker appeared in 12 native `simctl` screenshots and 108 MJPEG frames, before
the plugin viewer. Fitness+ alternated loading placeholders and Content
Unavailable; relaunching did not resolve it. Read-only logs on iOS 27 build
24A434 recorded 2,290 `FitnessSampleContent.SampleContentError.noItems` DataFlow
errors in one minute. This supports an app-side content failure, but does not
establish the exact cause of the visual flicker. No capture patch is justified
by that evidence, and no stable-runtime comparison was available.

## Transport measurements

A local Safari page synchronized static and animated phases. These samples
count H.264 records delivered by serve-sim; they do not measure BB canvas paint
rate or input latency.

| Run | Static fps / KiB/s | Animation fps / KiB/s | Animation median / p90 gap | Gaps >120 ms |
| --- | --- | --- | --- | --- |
| Historical loaded host | 6.7 / 21 | 53.1 / 136 | 16 / 25 ms | 2 in 8 s |
| Separate-device retest | 2.5 / 17 | 47.7 / 121 | 17 / 30 ms | 2 in 8 s |

Historical host load was 26–38 with seven existing alignment workers. The
separate-device sample ran at severe host load (about 657 before and 159
after); it delivered 382 animation frames in eight seconds and 15 static
frames in 6.01 seconds. A separate 50.5 fps sample on a concurrently used
device is provisional and excluded from comparisons. The requested quiet-host
retest remains incomplete. Unrelated user work was left running.

## Remaining limits and release state

- Xcode 27 accessibility returned `noFrontmostApplication` while Truffle was
  visibly running and touchable. Probes returned empty results for both tested
  display IDs/client types. Screenshot/coordinate input worked; successful
  accessibility-based tapping is not claimed.
- No Android SDK/AVD is installed. Its 18 focused automated checks pass, but
  real Android boot/install/input/preview are unverified. Preview uses
  serialized PNG polling, with a one-second delay after each capture, so its
  actual rate is at most about one frame per second.
- Marketplace schema/assets/build, 43 tests, upload retry tests, and v1 gate
  pass with the actual screenshot. One unchanged entry has a category warning.
- No public repository, tag, or marketplace PR has been published. Public
  source liveness cannot pass until the approved repository/tag exist. See
  `RELEASE_PLAN.md` and `LOCAL_VALIDATION.md` for the exact release checks.
