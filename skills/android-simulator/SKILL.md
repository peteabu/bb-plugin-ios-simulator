---
name: android-simulator
description: Run, inspect, and drive an installed Android virtual device in BB's simulator panel. Use for Android emulator, APK, or adb app testing; physical devices are excluded.
---

# Android emulator in BB

Use `android_sim_list_devices`, then `android_sim_attach` before installing or testing an Android app. This uses an existing Android SDK and virtual device; it never installs an SDK or downloads system images. `adb` and `emulator` are found on PATH, through `ANDROID_HOME` / `ANDROID_SDK_ROOT`, or in conventional Android Studio SDK locations. Create missing AVDs in Android Studio's Device Manager.

The Android platform shares the simulator panel with iOS. Its initial preview captures PNG screenshots about once per second, with one request at a time. It is a screenshot preview, not a video stream. The user can tap, long press, swipe, enter text, and press navigation or hardware buttons in the panel.

Install a built APK using `android_sim_install_and_launch` with its absolute `apkPath` on the BB **server host** and explicit `packageName` (for example `com.example.app`). Paths from a remote agent environment are not automatically transferred to the server. `android_sim_launch` opens an already installed package. Use `android_sim_screenshot` after launching and after UI changes to verify the result. There is no Android accessibility-tree tool in this version; use screenshots and normalized coordinates.

`android_sim_tap` and `android_sim_swipe` take normalized coordinates from 0 to 1. `android_sim_type` accepts printable ASCII plus newlines, up to 2000 characters; percent signs and Unicode are unavailable through `adb input`. `android_sim_press_button` supports home, back, overview, power, volume-up, volume-down, enter, and backspace. Agent screenshot output is capped at 4 MiB; reduce the virtual device's display resolution if a capture exceeds this limit.

Only `emulator-<port>` devices listed by adb are exposed. USB and network-connected physical devices are excluded. The shared Agent control setting applies to Android, and per-device consent is scoped to the current thread and plugin load. Manual panel controls remain usable when agent control is disabled.

Leave emulators attached unless the user asks to detach. `android_sim_detach` can optionally shut one down, but shutdown is refused while another thread is attached. On archive/delete, an emulator started by this plugin is stopped after its last attached thread releases it. An emulator that was already running is left alone. Plugin unload/reload stops emulator processes it started; reattach after reloading.
