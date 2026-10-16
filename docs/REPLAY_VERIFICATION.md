# Replay and control verification

Replay implementation verification, 16 October 2026. This records the initial
replay checks; subsequent UI and performance verification for v0.1.1 is in
[PERFORMANCE.md](PERFORMANCE.md). The final v0.1.1 source passed 199 plugin
tests across 21 files, all 26 native support tests, TypeScript and both builds.
The published v0.1.0 source remains unchanged.

## Automated checks

The focused suites exercise bounded AVCC retention and keyframe preroll,
immutable thread-scoped clips, reconnects, diagnostic identity matching,
report creation races, stale input sockets, wrong-thread mutations, consent
serialization and cancellation, and human/agent handoff during input.

Playback tests use an asynchronous decoder that enforces WebCodecs' rule
requiring a key chunk after flush. They cover long GOPs, seek followed by
play, pause/resume/end, bounded decoded-frame retention, cancellation and
stalled-decoder timeouts. Frontend tests cover attachment requirements,
handoff controls, replay polling/disposal, and preserving live input isolation.

Initial replay source checks passed: 190 tests across 20 files, TypeScript, plugin
build, and `git diff --check`. Lifecycle regressions also cover pending
attachment/restoration during disposal, pending HID connection handoff,
cancelled detach persistence, and shutdown consent cancellation.

## Real WebCodecs check

An isolated headless Chrome 155 process used a dedicated temporary profile
and a standalone localhost fixture, without accessing BB windows or Cua.
It generated 90 real AVC frames in a single GOP and passed 17 assertions:
initial/long-GOP seeks, rotation landmark pixels, seek-to-play keyframe
re-priming, no presentation of resume preroll, pause/resume/end, seeking after
terminal flush, immediate cancellation and complete disposal. No native
decoder/player errors occurred. The maximum observed input queue was 24
samples; live decoded frames peaked at two and ended at zero.

This check caught and corrected a brief resume preroll flash: dependencies
before the seek anchor are decoded but discarded without repainting the still.
The browser fixture and structured results are stored separately under
`verification/replay-webcodecs-headless/` in the workspace.

## Native simulator check

Used a dedicated iPhone 17 Pro simulator on iOS 27 with a local SwiftUI QA
fixture built using xcodebuild for that exact simulator destination. No other
thread's device was driven. The fixture shows a clock and marker count, emits
an OSLog marker on tap, and deliberately crashes on a separate button.

- Native screenshot verified marker count advancing from zero to one.
- Backend session inspection showed the matching agent tap and fixture log.
- Recording remained near 30 seconds with no reported error and less than
  2 MiB retained during the observed fixture run.
- The crash button terminated the fixture to SpringBoard. The recorder
  emitted a matching EXC_BREAKPOINT crash event about 31 seconds after the
  fixture's fault log, once macOS wrote its report.
- Saved a clip containing the crash event: 308 encoded frames and about
  29.96 seconds of visible video. Saved replay data remains temporary.

Crash-report delay can exceed the rolling video window. Collection timestamps
are explicit; a delayed report does not imply its event aligns with the exact
crash frame, or that a previously saved immutable clip gains later events.

## Native BB panel verification pending

Cua Driver reported a system-permission block while inspecting the new BB
window. Automation stopped and the user was directed to
`/settings/plugins/cua-driver` to make this machine's permission checklist
Ready. No native BB playback, seek, download, or complete human/agent handoff
flow is claimed from this run. That native-window recheck remains unverified.
Release validation includes the isolated real-component browser checks,
native codec/decoder lifecycle harness and integration tests documented in
PERFORMANCE.md; it does not claim the blocked native-window check passed.

Screenshots, fixture source/build products, polling output and replay metadata
are kept in the workspace's separate `verification/` directory, outside the
plugin source repository.
