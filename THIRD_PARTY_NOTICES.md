# Third-party notices

The BB plugin code is MIT licensed; see LICENSE. The following licenses apply
to the vendored native source and compiled `native/serve-sim-native.node` and
are distributed with this plugin.

## serve-sim 0.1.48

Copyright 2026 Evan Bacon. Apache License 2.0.

Source: https://github.com/EvanBacon/serve-sim/tree/6d009686ed08f7d8bd19bca9f9f67a9237931f44/packages/serve-sim

The `native/serve-sim` Swift source, tests, package manifest, and upstream build
script come from the published `serve-sim@0.1.48` npm package. The plugin changes
`Sources/SimNative/FrameCapture.swift` to poll the framebuffer change counter
for headless simulators. A change notice is present in that file. The local
build-only npm metadata and plugin build script are maintained separately.
See `native/serve-sim/PROVENANCE.md` for verified source hashes and build steps.

The complete upstream Apache license and copyright notice are in
`native/serve-sim/LICENSE`. The upstream repository at the recorded commit has
no root NOTICE file.

## node-swift 1.5.1

Copyright (c) 2021 Kabir Oberai. MIT License.

Source: https://github.com/kabiroberai/node-swift

The native module links node-swift's NodeAPI and NodeModuleSupport targets.
Its complete license is in `native/serve-sim/LICENSE.node-swift`.
NodeModuleSupport also includes node-gyp support under the MIT license,
Copyright (c) 2012 Nathan Rajlich. The complete notice is in
`native/serve-sim/LICENSE.node-gyp`.

## Build and runtime dependencies

`native/serve-sim/Package.resolved` pins SwiftSyntax 603.0.2 at
`79e4b74a295b6eb74a8b585e3a39d29e70c1dbd1` as a compiler-macro build dependency.
Source: https://github.com/swiftlang/swift-syntax

Other npm dependencies retain their licenses in their installed packages.
Apple frameworks and locally read Xcode device assets belong to Apple and
require a separate Xcode installation. No Xcode device artwork is included in
this plugin's release files.
