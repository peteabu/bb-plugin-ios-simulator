---
name: ios-simulator
description: Build, run, see, and drive an iOS app in Apple's iOS Simulator from a BB thread with the ios_sim_* tools. Use when the user asks to run, test, check, debug, or look at an iOS, iPadOS, SwiftUI, UIKit, React Native, Flutter, or Expo app, or to verify a UI change on a simulator.
---

# iOS Simulator

The iOS Simulator plugin streams a simulator into a panel beside the thread
and gives you native tools to control the same device. The user sees every
tap you make, and can tap too.

## Tools

| Tool | Use it to |
| --- | --- |
| `ios_sim_list_devices` | See simulators, their runtimes, and which are booted or attached. |
| `ios_sim_attach` | Boot a simulator (if needed), start streaming, and open the panel. Optional `device` is a name or udid. |
| `ios_sim_install_and_launch` | Install a built `.app` and launch it. Reads the bundle id from the app when you omit it. |
| `ios_sim_launch` | Relaunch an installed app by bundle id. |
| `ios_sim_screenshot` | See the screen. Returns an image. |
| `ios_sim_describe_ui` | List accessibility elements with normalized tap coordinates. Prefer this over guessing positions. |
| `ios_sim_tap` | Tap an element by label or a normalized point. |
| `ios_sim_swipe` | Scroll, pull to refresh, swipe to delete, edge swipes. |
| `ios_sim_type` | Type into the focused field. Tap the field first. |
| `ios_sim_paste` | Paste literal Unicode or multiline text into the focused field. |
| `ios_sim_press_button` | Home, lock, volume, and the action button. |
| `ios_sim_rotate` | Change orientation. |
| `ios_sim_open_url` | Open a deep link or web page on the device. |
| `ios_sim_set_appearance` | Switch light and dark mode. |
| `ios_sim_detach` | Stop streaming; optionally shut the device down. |

## Procedure

1. **Attach early.** When the request is about seeing or testing the app,
   call `ios_sim_attach` before you start editing, so the panel is open while
   you work. Name the device the user asked for ("run it on the iPhone SE").
2. **Build for the simulator** with your shell. Use the attached device's
   udid as the destination and a derived data path you control:

   ```bash
   xcodebuild -scheme <Scheme> -project <App>.xcodeproj \
     -destination 'platform=iOS Simulator,id=<udid>' \
     -derivedDataPath build -configuration Debug build
   ```

   The product is `build/Build/Products/Debug-iphonesimulator/<App>.app`.
   For React Native, Expo, and Flutter use their own run commands pointed at
   the udid, then attach and verify the same way.
3. **Install and launch** with `ios_sim_install_and_launch` and the `.app`
   path. Plain `xcodebuild build` does not install or launch anything.
4. **Look before you act.** Take `ios_sim_screenshot` after launch and after
   each change. Use `ios_sim_describe_ui` to find elements; tap by `element`
   label when one exists and by normalized coordinates only as a fallback.
5. **Verify your fix** the way a tester would: drive the flow, screenshot the
   result, and say what you saw. Do not claim a UI works without a screenshot
   that shows it.
6. **Leave the device attached** when you finish, unless the user asks you to
   shut it down. BB shuts down simulators this plugin booted when the thread
   is archived or deleted.

## Rules

- The first time you control a device the user may be asked to allow it. If
  they decline, stop driving the device and ask them to tap through instead.
- Never sign in to real accounts on a device you drive. Screenshots are sent
  to the model provider with the conversation.
- Coordinates are normalized: `x` and `y` run from 0 to 1 across the
  streamed screen, in its current orientation.
- `ios_sim_type` pastes Unicode text by default; `\n` presses Return and
  `\t` presses Tab. Use `ios_sim_paste` for literal multiline text. If the app
  blocks paste, set `method: "keys"` for US-keyboard ASCII events. Device Hub
  must release input for either method to work.
- Logs: `xcrun simctl spawn <udid> log stream --predicate 'subsystem == "<bundle id>"'`
  and crash reports under `~/Library/Logs/DiagnosticReports`.
