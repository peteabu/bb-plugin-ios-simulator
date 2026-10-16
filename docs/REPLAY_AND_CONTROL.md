# Replay and shared control

## Requirements

Add four capabilities to the iOS panel: a rolling replay of the
last 30 seconds, a timeline linking video to input and app diagnostics,
exclusive control across threads, and explicit human/agent handoff. Work is
local until a separately reviewed release. Existing Android preview remains
independent of the iOS video recording path.

## Design

- The backend subscribes to native AVCC while an iOS stream is attached. Keep
  the latest 30 seconds plus the preceding decoding keyframe in bounded
  memory. Save a replay as an immutable in-memory snapshot. Bound snapshot
  count/bytes, discard buffers on detach/disposal, and expose replay data over
  HTTP rather than exceeding RPC payload limits. A browser canvas decodes
  H.264 at recorded timestamps; scrubbing starts from a prior keyframe.
  Live storage is capped at 32 MiB per device; three saved clips share a
  64 MiB serialized-payload ceiling. Downloads are JSON containing H.264,
  timestamps, orientation and events. Saved clips expire with the session.
- Each replay includes timestamped input, control, lifecycle, error, app-log
  and matching crash events. Input text is represented by its character count.
  App logging follows only the app explicitly launched through the plugin;
  unavailable diagnostics are shown as unavailable, never fabricated.
  Match new crash reports by bundle ID, PID, crash report type and simulator
  path. Timeline times are collection times; OS crash reporting can be delayed.
- Each iOS device has one controlling thread and a human/agent mode. Other
  threads may observe but cannot mutate the device. An explicit panel action
  can transfer ownership; an agent cannot take control from another thread or
  from a human. The initial attachment claims an unowned device in the actor's
  mode. Reattachment preserves an explicit handoff.
- Enforce control on every mutating agent call, panel RPC, and HID message.
  A handoff aborts active operations, including consent prompts and pending
  input connections. Stop input from old owners even if
  their UI is stale. Release ownership when its thread detaches or disappears.
- The panel displays who controls the device, Take control / Let agent drive,
  replay readiness, Capture 30s, playback with a synchronized event timeline,
  and return to Live. Replay never sends input to the live device. Downloads
  contain the captured replay and events; no external service is required.

## Shared contracts

`lib/session-types.ts` defines control state, timeline events, replay status,
clip metadata and replay payload. Server modules own bounded recording and
control policy. `server.ts` wires typed RPC, HTTP, lifecycle and tool guards.
The existing simulator panel composes replay playback and handoff controls.

## Verification

Test rolling/keyframe retention and byte bounds, immutable saves, cleanup,
wrong-thread and stale-socket rejection, in-flight handoff cancellation, and
playback disposal/timestamp behavior. Run full tests, TypeScript and plugin
build, reload locally, then verify human/agent handoff and capture/playback in
native BB on the dedicated simulator. Do not drive another thread's device.

Record completed checks and remaining live verification in
`REPLAY_VERIFICATION.md`. The published v0.1.0 tag and its marketplace
submission remain separate from this local development work.
