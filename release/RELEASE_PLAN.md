# Proposed public release

Local implementation and marketplace preparation are complete. No public
repository, release tag, marketplace branch, or pull request has been created.
Public-source verification still requires the approved release to exist.

## Release identity

- GitHub account: **peteabu** (Peter Abu), verified read-only.
- Repository: **peteabu/bb-plugin-ios-simulator**.
- URL: `https://github.com/peteabu/bb-plugin-ios-simulator.git`.
- Package: **bb-plugin-ios-simulator 0.1.0**; BB ID: **ios-simulator**.
- Proposed immutable tag: **v0.1.0**; marketplace range: **^0.1.0**.
- Final plugin commit: record its full SHA in the separate approval handoff
  after the final local documentation commit. Do not approve a moving HEAD.
- Marketplace fork: **peteabu/marketplace**, branch **submit-ios-simulator**.
- Final local marketplace commit:
  **8bb129d4190733ddf8fcdcc059f393450ee59d00**.
- Git is the release source; npm publication is not proposed.

## Verified result

- **110 tests across 14 files**, TypeScript checking, and the BB plugin build
  pass. The plugin reloaded successfully.
- Explicit attachment selects the requested iPhone 17 Pro in the panel and
  promotes it as the default for subsequent tools, including reattachment.
- Native BB Home, Lock, and the toolbar's full rotation cycle pass. Portrait,
  landscape, and return-to-portrait display align the image, device frame,
  and mask. Foreground pointer actions hit the expected asymmetric targets
  in portrait, landscape left, and landscape right; screenshots and HTTP
  target logs confirm the mapping.
- A persistent 90-second H.264 check decoded **546/546 frames without errors**,
  including the Lock transition before the second keyframe. The suspected
  encoder freeze was not reproduced; no new native encoder patch was needed.
- Unicode insertion was verified in Truffle. Android shared screenshots now
  survive cancellation of one caller while another caller still waits.
- Both native binaries, source, build scripts, metadata, and MIT/Apache-2.0
  and node-swift/node-gyp notices are tracked. Binary hashes match metadata.
  Runtime serve-sim is pinned exactly to **0.1.48** in manifest and lockfile.
  No Xcode device artwork is bundled.

See `VERIFICATION.md` for the detailed live checks and their evidence.

## Marketplace artifacts and checks

The draft under `marketplace/` matches the clean, full-history checkout at
`/tmp/bb-ios-marketplace-review`. Its final branch diff contains exactly:

- `entries/ios-simulator.json`
- `icons/ios-simulator-c4007f39.svg`
- `overview/ios-simulator.md`
- `screenshots/ios-simulator/panel-eb92b3d6.png`

The overview is an unchanged copy of `PLUGIN_OVERVIEW.md`. The screenshot is
a reviewed real native BB panel crop showing Truffle's Create conversation
and Wikipedia topics, Apple device frame, picker, and footer controls. It is
**1472×1600**, **278,376 bytes**, with no private chat or paths. The latest
fixes do not change portrait appearance; the reviewed image remains accurate.
The original full private BB window capture is excluded.

Current checks pass with that screenshot: v2 schema, plugin ID/categories,
content hashes, image format/width/size, no orphan screenshots, overview and
draft-copy equality, full marketplace build (**384 entries**), all **43
marketplace tests**, upload retry tests, v1 addition gate, and whitespace.
One unchanged entry has an unrelated missing-category warning.

The official marketplace default branch was re-fetched at
`92aa56203ec26369bbf1ba05028bade5fe3a5606`. Its README, v2 schema, categories,
icon rules, and current entries supplied the contract. The temporary checkout
is clean. Its `origin` points at official upstream; publish only to the
submitter fork using a separate remote.

Public-source liveness was deliberately omitted while the proposed plugin
repository is unpublished. The last targeted source check returned Repository
not found. Run it after the approved public repository and tag exist; it is
not recorded as passed.

## Performance limits

The historical loaded-host transport sample measured static capture at
**6.7 fps / 21 KiB/s** and animation at **53.1 fps / 136 KiB/s**. Frame-gap
median was **16 ms**, p90 **25 ms**, with **two gaps over 120 ms in 8 s**.
Host load was **26–38**; concurrent device use during that sample has not
been established.

A later **50.5 fps** original-device retest was affected by concurrent thread
use and remains provisional. A separate-device run measured **47.7 fps**,
**382 frames in 8 s**, median **17 ms**, p90 **30 ms**, and **two gaps over
120 ms**. Idle was **2.5 fps**, **15 frames in 6.01 s**. That device was isolated,
but host load was about **657 before** and **159 after**. These samples do not
fulfil a quiet-host retest or support normal-host performance claims.

Live Android verification still requires an SDK/AVD on a suitable host.
The current Android path uses PNG polling, not video or accessibility
inspection. The source npm pack omits dist; this is a Git release candidate.

## One publication approval

The submit-a-plugin skill requires approval before the first release
mutation. Prepare one approval request containing the final full plugin
commit SHA, the marketplace commit above, account, repository URLs,
package/version, tag/range, and all commands below. That single approval
covers both the plugin release and marketplace submission for those exact
commits and commands. No publication approval has been requested or inferred.

From the plugin checkout, substitute the approved full plugin commit SHA:

```sh
gh repo create peteabu/bb-plugin-ios-simulator --public --source . --remote origin
git tag -a v0.1.0 FULL_APPROVED_PLUGIN_COMMIT_SHA -m 'Release v0.1.0'
git push origin FULL_APPROVED_PLUGIN_COMMIT_SHA:refs/heads/main
git push origin refs/tags/v0.1.0
```

Verify the public tag resolves to the approved commit and run marketplace
source validation before continuing. From the prepared marketplace checkout:

```sh
git remote add submitter https://github.com/peteabu/marketplace.git
npm run check
git push submitter 8bb129d4190733ddf8fcdcc059f393450ee59d00:refs/heads/submit-ios-simulator
gh pr create --repo get-bb/marketplace --base main \
  --head peteabu:submit-ios-simulator --title 'Add plugin entry: ios-simulator' \
  --body-file /ABSOLUTE/PATH/marketplace-pr-body.md
```

Fill the exact body-file path in the approval handoff. The local remote-add
command is unnecessary if an already verified `submitter` remote exists.
Continue with the approved marketplace publication once source checks pass;
no second approval is needed for unchanged approved commits and commands.
If validation requires code or artifact changes, update the concrete release
handoff before publishing changed commits.
