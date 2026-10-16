# Vendored serve-sim native capture source

## Source and verification

The native source was copied from the published `serve-sim@0.1.48` npm tarball:

- Package: https://registry.npmjs.org/serve-sim/-/serve-sim-0.1.48.tgz
- Repository: https://github.com/EvanBacon/serve-sim
- npm `gitHead`: `6d009686ed08f7d8bd19bca9f9f67a9237931f44`
- Repository package directory: `packages/serve-sim`
- Tarball SHA-1: `e034e3d12e42b7649ccf8f531a88fa5710367b1b`
- npm integrity: `sha512-Kfg++zbtrRHYEOGAVk/9ftZamp40Qpz8WgP3idWaHoGaCJ01TrEZeq0UnWIsrGSaGhGgi0ytxMOsrEo3H/bFiA==`

The tarball SHA-1 and source differences were checked on 2026-10-16. All
vendored Swift source, tests, `Package.swift`, and the upstream `build.sh`
match the published package except `Sources/SimNative/FrameCapture.swift`.
That file adds a framebuffer change-counter poll for headless simulator
capture, controlled by `SERVE_SIM_POLL_MS` (8 ms by default), and carries a
prominent modification notice.

The Apache-2.0 license is copied verbatim from the repository at that exact
commit because the npm tarball omits it. It retains Evan Bacon's copyright
notice. That repository commit has no root NOTICE file.

The private local `package.json` and lockfile are plugin-maintained build
metadata, not the upstream npm package. They pin `node-swift` to `1.5.1`.
`Package.resolved` pins SwiftSyntax to `603.0.2` and revision
`79e4b74a295b6eb74a8b585e3a39d29e70c1dbd1`. The included node-swift and node-gyp
license copies apply to compiled code from those targets.

## Rebuild the distributed module

Use an Apple Silicon Mac with Xcode, Swift 6, and Node.js `20.19+`, `22.13+`,
or `24+`. Xcode 27 beta and Apple Swift 6.4 are the current verification
host's toolchain; earlier toolchains have not been verified.

From the plugin root:

```sh
npm run build:native
```

The plugin's `scripts/build-native.sh` installs the locked build dependencies
with `npm ci --ignore-scripts`, builds the dynamic Swift product for arm64,
strips it, and ad-hoc signs `native/serve-sim-native.node`. It uses local cache
and output directories under `native/`, all ignored by Git. The upstream
`Sources/SimNative/build.sh` is preserved as source provenance; use the plugin
script because it supplies the local build layout.

Keep the resulting `.node` file in Git so a public Git install does not need
to build Swift. Rebuilding may change binary hashes when toolchains or build
paths change; this records the source and dependency inputs, not a guarantee
of byte-for-byte reproducibility across Macs.

## Runtime installation

The runtime npm dependency is pinned exactly to `serve-sim: 0.1.48`.
`server/native-patch.ts` checks both package name and version before it copies
the module into the dependency. An unverified manifest or different version
uses the ordinary serve-sim capture path instead. The first original module
is saved beside it as `.orig`. The same version check protects restoration.

To update serve-sim, review and rebase the native changes, record new
provenance and licenses, rebuild and test the module, then change both the
dependency pin and installer version constant together.
