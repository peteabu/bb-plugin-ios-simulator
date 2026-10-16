# Simulator pasteboard helper

`Pasteboard.swift` is a small MIT-licensed UIKit command-line executable
written for this plugin. It reads UTF-8 on stdin and writes
`UIPasteboard.general.string` inside the iOS Simulator. The distributed
`simulator-pasteboard` binary targets arm64 iOS 15+ simulators.

Xcode 27 can return success from `simctl pbcopy` without storing the input.
This is also documented by Callstack's agent-device project:
https://oss.callstack.com/agent-device/docs/known-limitations#ios-simulator-simctl-pbcopy-writes-nothing-under-xcode-27

No source code was copied from that project. The helper only uses Foundation
and UIKit supplied by the user's Xcode installation.

The setter publishes asynchronously in a short-lived command-line guest.
The helper gives the main run loop 100 ms and performs a read before exit.
The backend must still compare a separate `simctl pbpaste` result with the
requested text before invoking Paste; an exit code alone is insufficient.

Rebuild on Apple Silicon with Xcode's simulator SDK:

```sh
npm run build:pasteboard
```

The build script uses a local ignored module cache and ad-hoc signs the
executable. Commit the resulting binary beside its source so installation
does not require compilation. Current source, target, toolchain, and binary
SHA-256 are recorded in `BUILD_METADATA.json`.

On 2026-10-16, the final bundled helper was run inside the attached iOS 27
simulator three times. A separate `simctl pbpaste` read matched each 54-byte
UTF-8 input exactly, including an em dash, accented Latin text, CJK, newline,
tab, and emoji. This checks clipboard persistence; the app still needs a
focused field that accepts the paste action.
