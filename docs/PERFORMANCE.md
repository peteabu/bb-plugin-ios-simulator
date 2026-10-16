# Simulator responsiveness regression

Compare the current replay/control implementation with the earlier live
viewer. Preserve the current UI, replay retention limits and exclusive
control; identify work on the capture, presentation and input paths before
changing them. Do not drive or stop another thread's simulator.

## Findings and changes

- The replay recorder adds an AVCC HTTP subscriber. Previously the native
  capture engine created a VideoToolbox encoder for every subscriber, so
  replay and the live viewer encoded the same source twice. They now share
  one encoder per capture engine with independent delivery and backpressure.
  Joining viewers receive decoder configuration and a fresh keyframe. The
  wire format is unchanged.
- Ownership handoff closes stale HID sockets, but the viewer previously waited
  at least 400ms before reconnecting. A new lease now reconnects immediately;
  genuine connection failures retain bounded backoff. Stale socket callbacks
  cannot affect the replacement or resume input from a previous owner.
- Replay event retention previously recomputed serialized byte sizes for every
  retained event on each insertion and status read. A 100-log burst measured
  roughly 20–80ms in the initial server audit. Immutable events now cache
  their UTF-8 size once; trimming sums numeric sizes. Byte/age limits and
  log-priority eviction are preserved, with exact accounting checked after
  expiration and eviction.
- Periodic React work and recording overhead were measured against the
  earlier viewer; the changes below address the measured work.

## Verification

Use focused cancellation/reconnection and encoder lifecycle regressions,
TypeScript, plugin/native builds and isolated real-browser playback/input
checks. Record comparative timings and their limits. Machine CPU load is
currently high; a busy machine alone does not establish a plugin regression.
Native BB inspection remains limited by the previously reported Cua block.

Final checks passed: 199 plugin tests, all 26 native support tests, TypeScript
and plugin/native release builds. The bundled arm64 module is stripped and
ad-hoc signed; its checksum and build details are in native provenance.
The local plugin was reloaded successfully; the dependency's installed module
matches the rebuilt checksum. A read-only check of this thread's device showed
recording resumed, roughly 25 seconds buffered and no replay error. Control
remained unassigned; no simulator input or app replacement was performed.

## Native encoding

The capture engine owns one AVCC encoder from its first subscriber until its
last unsubscribe. Compressed frames fan out through independent ordered
queues, so HTTP backpressure does not block another viewer or the recorder.
Each queue includes in-flight delivery in an eight-frame, 2MiB budget. A
larger valid keyframe can be the sole packet up to the existing 64MiB wire
ceiling, preserving large-screen support without an unbounded queue.

Joining or recovering subscribers wait for a keyframe and receive cached
decoder configuration immediately before it. Overflow drops that subscriber's
dependent frames; it cannot resume on a delta from a broken decode chain.
Shared keyframe requests are coalesced to 250ms and use a generation counter
so an encode already in flight cannot erase a newer request.

Teardown clears queued packets and pending requests, removes the canonical
capture consumer at the last unsubscribe, and releases its encoder even if
callers retain an old unsubscribe closure. Independent review checked these
ownership and decoder-chain boundaries. Already-running async send callbacks
can complete if they ignore cooperative cancellation; queued delivery stops.

An isolated generated-pixel-buffer integration check compiled the actual
CaptureEngine and H264Encoder sources, replacing only the simulator frame
source and adding test counters. Two subscribers created exactly one encoder
and received identical compressed streams; independent VideoToolbox decoders
decoded 25/25 frames each, with zero errors and equal pixel samples. Last
unsubscribe invalidated the encoder while old unsubscribe closures remained
retained; further generated inputs did no encoding. Resubscription created a
fresh encoder and decoded eight more frames. Input was paced by encoder
completion, so this proves fanout/codec/lifecycle correctness, not real-device
frame rate. Harness, instructions and results are in workspace
`verification/native-share-review/`.

## Input and recorder checks

The input regression test changes the control lease while its old socket is
waiting for a retry. A replacement opens without advancing the fake clock;
late open, close and configuration callbacks cannot change the new connection.
Genuine failures still wait 400ms, and unmount cancels the pending retry.

The recorder now stores each immutable event with its serialized UTF-8 size.
A regression checks exact totals with multibyte text after log-priority
eviction, expiration and a fresh event. Existing count, age, frame and saved
clip limits continue to pass.

A bounded synthetic comparison used 1,800 retained AVC frames and 1,000 log
insertions per detail size. Mean insertion time for 160/400/2,000-character
details changed from 279/671/682 microseconds to 19/17/17 microseconds. These
same-process before/after timings ran on an uncontrolled busy host; they show
the eliminated serialization work, not device or input latency. The harness
and raw results are in workspace `verification/recorder-performance/`.

## Frontend work

An isolated Chrome fixture compared `5ea40e4`'s simulator component with the
current interface. Both used the same dependencies and styles, a controlled
60Hz canvas stream, one-second stream statistics, and mocked SDK/RPC/HID
boundaries. React ran in development mode with Profiler and render counters.
The Activity stress case contained 100 events. These results identify frontend
work; they do not measure native encoding, real input/network latency, or
production-build absolute CPU, and host load was not controlled.

Closed live view was similar before the targeted fixes: 19.0ms versus 19.4ms
of total React rendering over six seconds. The live video renderer and its
stable effect dependencies were unchanged; the existing one-second badge and
statistics updates did not become per-frame React work.

The open live Activity list took 315ms over six seconds, including two long
tasks, because unrelated parent updates rebuilt its rows and each row created
a locale time formatter. Saved playback rebuilt the same 100 rows on every
playhead update: 1,103.9ms over four seconds, with a 15.6ms p95 commit. It also
kept polling live timeline/status even though the selected replay is immutable.

The frontend now caches one date formatter and memoizes the Activity list by
its events, active event ID, playback mode, start time and stable seek callback.
The transport retains its normal playhead updates. Live timeline polling runs
only with Activity open; periodic live polling stops in Replay. Relevant
realtime notifications can still refresh replay status, and returning Live
resumes readiness updates.

Verification includes hidden/open timeline polling, pause during immutable
replay, resumption on Live, event highlighting while the transport advances,
scoped capture/download/seek, and disposal. The bounded before/after browser
measurements and source hashes are stored in workspace
`verification/frontend-performance-audit/` outside the plugin release.

The bounded recheck retained the same scenarios and 100-event list:

| Frontend scenario | Before total React work | After total React work |
| --- | ---: | ---: |
| Live Activity, six seconds | 315.0ms | 61.8ms |
| Replay Activity, four seconds | 1,103.9ms | 229.3ms |

Replay Activity's p95 commit fell from 15.6ms to 1.3ms. Its event list rendered
six times while the transport retained 244 updates over four seconds; live
Activity rendered its list three times over six seconds. The recheck reported
no long tasks or runtime exceptions. Closed live view made no timeline calls;
both saved Replay scenarios made no periodic live-data calls. These local
development-profiler reductions are about 80% for the stressed open list,
with the measurement limits above; they do not establish an equivalent
native-stream or end-to-end input improvement.

A separate real-WebCodecs component fixture decoded about 60 frames/second
with either version, without runtime errors or long tasks. Paint callbacks
varied with decoder-output/display-refresh phase and run order: the final
clean pair was 56.7 versus 43.6 paints/second, while an earlier current-first
run reached 57.9. The live video renderer source is identical across those
versions. This does not establish a version-caused paint regression or a
native-stream improvement; native encoding and real HID were outside that
fixture. Raw results and lifecycle/cleanup details are in workspace
`verification/performance-review/REPORT.md`.
