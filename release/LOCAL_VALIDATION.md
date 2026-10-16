# Final local validation record

The final plugin checks pass: **110 tests across 14 files**, TypeScript,
BB plugin build, and successful reload. Live checks cover explicit attachment
and persisted default selection, Home, Lock, full-cycle toolbar rotation,
portrait/landscape frame and mask alignment, and foreground asymmetric-target
taps. The persistent H.264 run decoded 546/546 frames without errors. Detailed
evidence is in `VERIFICATION.md`.

The existing portrait screenshot was reviewed after the fixes and remains
accurate. Both draft trees hold the same entry, hashed SVG icon, unchanged
overview, and `panel-eb92b3d6.png` (1472×1600, 278,376 bytes). No full private
window capture is included.

Marketplace validation with the final artifacts passes:

- Current v2 entry schema, ID/category, icon/image hashes, PNG width/size/format.
- No orphan screenshots; overview and draft-copy equality.
- Full build: 384 entries; one unrelated unchanged missing-category warning.
- All 43 marketplace tests and upload retry tests.
- v1 addition gate and diff whitespace.

The clean temporary marketplace checkout is `/tmp/bb-ios-marketplace-review`,
branch `submit-ios-simulator`, commit
`8bb129d4190733ddf8fcdcc059f393450ee59d00`. Its net diff contains exactly the
entry, content-hashed icon, unchanged overview, and approved screenshot.
Native binaries and license/provenance notices are tracked in the plugin,
and binary SHA-256 values match BUILD_METADATA.json.

## Reproducing checks if artifacts change

From the plugin checkout, for implementation changes:

```sh
npm run typecheck
npm test
bb plugin build
git diff --check
git status --short
```

From a full-history marketplace checkout containing the final artifacts:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run gate:v1
git diff --check
git status --short
```

Inspect the branch diff against official main. Only entries/ios-simulator.json,
the one icon, screenshots/ios-simulator/, and overview/ios-simulator.md belong
in the submission. Each screenshot must be faithful PNG/JPEG/WebP, at least
1200 pixels wide, at most 2 MiB; maximum six images. No private or unreferenced
files may be included. A documentation-only edit does not require repeating
implementation tests that have already passed.

## Pending source check and publication

Public-source liveness has not run because the source repository/tag remains
unpublished. After the single combined publication approval and plugin release:

```sh
npm run check
```

Verify the public v0.1.0 tag and selected range resolve to the approved plugin
commit before publishing the already approved marketplace commit/PR. The
current checker has no plugin-only option. Do not claim source liveness
passed before it succeeds.

Use one approval handoff for both exact commits and all publication commands
in RELEASE_PLAN.md. This local record authorizes no push, tag, repository
creation, pull request, or npm publication on its own.
