# iOS Simulator for BB

Run an iOS app beside your BB thread, tap through it yourself, and let agents
build, launch, and test on the same device.

- **Live panel.** Choose a device and Attach to boot and stream it. Click to
  tap, drag to swipe, and focus the screen to type. Paste text with ⌘V,
  including Unicode and multiline text. Choose **Take control** before using
  the screen, then **Let agent drive** to hand it back. ⌘⇧H goes home, ⌘L locks, ⌘↑/↓ changes
  volume, ⌘→ rotates, and ⌘S saves a PNG.
- **Thread shortcut.** The Simulator button in the thread header opens the
  panel. Attaching a device from an agent also opens it automatically.
- **Device frame.** The panel uses the selected simulator's local Xcode device
  profile and DeviceKit artwork when available. It keeps a CSS frame when a
  profile or image is unavailable. Apple artwork is read from your Xcode
  installation and is not bundled with the plugin.
- **Agent tools.** `ios_sim_attach`, `ios_sim_install_and_launch`,
  `ios_sim_screenshot`, `ios_sim_describe_ui`, `ios_sim_tap`, `ios_sim_swipe`,
  `ios_sim_type`, `ios_sim_paste`, `ios_sim_press_button`, `ios_sim_rotate`,
  `ios_sim_open_url`,
  `ios_sim_set_appearance`, `ios_sim_launch`, `ios_sim_list_devices`,
  `ios_sim_detach`, and `ios_sim_repair_input`.
- **Replay and diagnostics (local development).** Keep the last 30 seconds of
  iOS video, capture a replay, and seek through its input/app-log/crash timeline.
  `ios_sim_session` reads session health and recent events;
  `ios_sim_save_replay` captures a replay without taking control.
- **Consent.** The first agent control request asks for permission once per
  device. Change this under Settings → iOS Simulator.
- **Lifecycle.** Archiving or deleting a thread shuts down simulators this
  plugin booted. Detaching starts a 10-minute idle timer. Simulators you booted
  yourself remain running.

## Requirements

- macOS on Apple Silicon with Xcode and the iOS platform installed. Use
  `xcodebuild -downloadPlatform iOS` to install the platform.
- Node.js 20 or newer on PATH. The capture helper,
  [serve-sim](https://github.com/EvanBacon/serve-sim), runs under Node.
- BB 0.46 or newer with Plugin SDK 0.6.37 or newer.
- The BB server runs on the Mac that has the simulators. No external service
  or additional account is required.

The bundled native module targets Apple Silicon. Xcode 27 beta is the current
verification toolchain. Older Xcode versions and Intel Macs have not been
verified.

## Install

From a source checkout:

```sh
cd bb-plugin-ios-simulator
npm ci --include=dev
bb plugin build
bb plugin install .
```

Open a thread and use its Simulator header button, or choose **iOS Simulator**
from the panel's new-tab menu. You can also ask the agent to run your app.

The public [v0.1.0 source](https://github.com/peteabu/bb-plugin-ios-simulator/tree/v0.1.0)
and [marketplace submission](https://github.com/get-bb/marketplace/pull/578)
are available. The replay/control changes in this working tree are local
development work awaiting their own release.

See the [replay/control design](docs/REPLAY_AND_CONTROL.md) and
[verification record](docs/REPLAY_VERIFICATION.md) for the local changes.

## Replay and shared control

The iOS backend keeps up to 30 seconds of video and timestamped input in
memory while attached. **Capture 30s** captures the available window; choose
Replay to play, pause, scrub, or jump to a timeline event. Replay cannot send
input to the live device. **Live** returns to the current simulator.
Open **Activity** for the event timeline, app diagnostics and replay downloads.
The control dock keeps Home, Lock, Rotate and Screenshot in reach; **Device
options** contains volume, stream details, Detach and Shut down.

Replays are temporary: detaching or reloading clears them. Download replay
JSON to retain the encoded H.264 video, timing, orientation and events.
Playback in the panel requires WebCodecs. Up to three snapshots share a
64 MiB limit; each device's live buffer is capped at 32 MiB and can contain
less than 30 seconds under that limit. Decoding retains an earlier keyframe
without displaying frames before the selected window.

One thread controls each iOS device. A new panel attachment claims human
control; an agent attachment claims agent control. Attaching as an observer
never replaces another thread's owner or undoes an explicit handoff.
**Take control** cancels pending agent input and invalidates old input sockets.
**Let agent drive** grants permission and returns control in one action.
The global Agent control setting still applies. Other threads can observe;
they cannot launch apps, type, rotate, repair, or shut down that device.
Ownership is released when its thread detaches or closes and resets on reload.

Launching an app through the plugin follows that app's PID for logs and
matches new crash reports against the app, process and simulator. Diagnostics
show their availability; an unsupported report is never treated as a verified
crash. Timeline times reflect collection at the server. Crash reports can
arrive after the crash, so their appearance can be delayed. Typed text is
represented by a character count in input events; video still shows the screen.

CLI equivalents:

```sh
bb ios-simulator session [device] --thread <thread-id>
bb ios-simulator replay [device] --thread <thread-id>
```

## How it works

The backend runs one serve-sim process per attached iOS device. serve-sim
reads the framebuffer, uses the Mac's hardware H.264 encoder, and accepts HID
input on loopback. The panel decodes video with WebCodecs; browsers without it
use MJPEG. BB proxies the stream and input, so the panel talks to BB's own
origin. The helper's port stays on loopback.

Agent tools use the same input path, `xcrun simctl`, and serve-sim's
accessibility endpoint. Screenshots sent to the model are downscaled with
`sips` according to the plugin setting. You see the device while an agent
controls it, and can interact with it yourself.

## Develop

```sh
npm run typecheck
npm test
bb plugin build
bb plugin dev
```

The release includes `native/serve-sim-native.node`; a normal installation
does not need a Swift build. To rebuild it on Apple Silicon:

```sh
npm run build:native
npm run build:pasteboard
```

See [native provenance and build inputs](native/serve-sim/PROVENANCE.md) and
[third-party notices](THIRD_PARTY_NOTICES.md). The separate
[UIKit pasteboard helper](native/PASTEBOARD.md) is also included as a signed
Apple Silicon simulator executable. The runtime dependency is pinned
exactly to serve-sim 0.1.48. The installer refuses to overwrite a helper from a
different version or an unverified package.

## Android emulator preview

Android is an initial emulator-only path in the same panel. It requires an
existing Android SDK installation with `adb` and `emulator`, plus an AVD you
have already created. The plugin does not download SDKs or accept physical
devices. It resolves the SDK through PATH, `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
or conventional macOS/Linux SDK paths.

Choose an Android AVD and Attach. The preview polls PNG screenshots serially
at about one frame per second. You can tap, swipe, type ASCII text, press
buttons, install an APK, and launch its package. Android Unicode typing and an
accessibility tree are not available in this initial path.

Agent tools: `android_sim_list_devices`, `android_sim_attach`,
`android_sim_detach`, `android_sim_screenshot`, `android_sim_tap`,
`android_sim_swipe`, `android_sim_type`, `android_sim_press_button`,
`android_sim_install_and_launch`, and `android_sim_launch`. APK installation
requires an absolute `apkPath` on the BB server and an explicit `packageName`.

Android uses the shared Agent control setting, with permission per thread and
device for each plugin load. An emulator started by the plugin stops when its
last owning thread is archived or deleted, or when the plugin unloads. A
previously running emulator stays running.

The Android workflow has automated checks but has not been exercised against a
live emulator on the current host, which has no Android SDK installed.

## Xcode input behaviour

- **Device Hub captures input.** If Device Hub owns the device, panel and
  agent taps may be ignored. **Repair input** restarts SpringBoard and closes
  running apps. Close the device's Device Hub window afterwards, then
  relaunch your app.
- **Home relaunches SpringBoard.** On recent Xcode versions, serve-sim uses a
  SpringBoard relaunch because the simulated Home button can be ignored.
- **Typing and paste.** `ios_sim_type` pastes printable text, preserving newline
  as Return and tab as Tab. `ios_sim_paste` pastes a literal string, including
  multiline or Unicode text. For apps that reject paste, `ios_sim_type` with
  `method: "keys"` uses US-keyboard ASCII injection. Panel ⌘V pastes literal
  text. Focus an editable field first; the app must accept the paste action.
  A small bundled UIKit helper writes inside the simulator when Xcode 27's
  `simctl pbcopy` returns success without storing text. Writes are verified
  through `simctl pbpaste` before the paste action is sent.

## Capture smoothness

Headless iOS 27 simulators can miss framebuffer change notifications. The
bundled native patch checks the framebuffer change counter every 8 ms and
captures only when pixels change. `SERVE_SIM_POLL_MS` adjusts that interval.
The original dependency module is kept beside it as `.orig`.

If the patch is unavailable, the backend requests captures 60 times per
second. The `captureHz` setting overrides this automatic choice. Forced
capture copies and encodes even an unchanged frame and uses more CPU.

The panel's stats line shows painted and decoded frames per second, decoder
queue, and bandwidth. To inspect Mac CPU contention:

```sh
bb ios-simulator diag-cpu
```
