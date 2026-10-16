# Simulator interface polish

The device should be the main focus. Reduce permanently visible chrome,
make ownership understandable at a glance, and keep primary controls easy to
reach in narrow side panels. Preserve control policy and recording behavior.

- Combine device identity, connection and ownership into one compact header.
- Use a quiet platform switch and one replay toolbar. Put app diagnostics,
  recording details and event output in an initially closed activity drawer
  below the device stage.
- Keep Home, Lock, Rotate and Screenshot in a centered control dock; move
  volume, connection/shutdown and stream details into an explicit secondary
  disclosure. Avoid wrapping the dock at narrow widths.
- Make playback the main surface in Replay. Use a restrained transport,
  readable timecodes, and concise expandable event rows.
- Use consistent 40px targets, visible keyboard focus, immediate local busy
  feedback, specific short transitions and reduced-motion support. Avoid
  layout shifts as status labels change.

Verify actual components in isolated browser fixtures at narrow and regular
widths, dark and light themes, Live and Replay, and with Activity open. Keep
these fixtures separate from shipped source. Run affected behavior tests,
TypeScript and the plugin build, then reload locally. Native BB inspection
remains blocked by the previously reported Cua permission state; do not claim
that separate verification without resolving the block.

## Verification

- 191 tests across 20 files pass. TypeScript, plugin build and diff checks pass.
- Eleven isolated actual-component browser cases cover dark/light themes,
  regular/narrow panels, Live, Replay, Activity, and Device options. No runtime
  exceptions, horizontal overflow or controls smaller than 40px were observed.
- At 320×640, the device stage retains about 410px in Live and 245px with
  Activity open; Replay retains about 422px or 235px with Activity open.
- Device options dismisses with Escape and an outside click. The affected
  tests retain handoff/input isolation, per-action pending feedback, replay
  navigation, event seeking, download and polling/disposal coverage.
- The browser fixture renders actual components and built plugin CSS, with
  mock SDK/network boundaries and existing local Xcode artwork. It checks
  layout and interaction, not native BB integration or live stream performance.
  Screenshots and results are outside the source repository under
  `verification/polish-review/` in the workspace.
