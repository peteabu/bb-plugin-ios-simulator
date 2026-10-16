# Proposed public release

This is a local preparation record. No repository, tag, npm package,
marketplace branch, or pull request has been published.

## Identity and source

- Authenticated GitHub account: **peteabu** (Peter Abu), verified read-only.
- Proposed public repository: **peteabu/bb-plugin-ios-simulator**.
- Proposed remote: `https://github.com/peteabu/bb-plugin-ios-simulator.git`.
  The repository did not exist at the preparation check (GitHub returned 404).
- Package: **bb-plugin-ios-simulator 0.1.0**; derived BB plugin ID:
  **ios-simulator**.
- Release tag: **v0.1.0**; marketplace Git tracking range: **^0.1.0**.
- Release commit: **pending the final verified local commit**. Record its full
  SHA in the approval request before running any release command.
- Existing public marketplace fork: **peteabu/marketplace**.
- Local marketplace draft branch: **submit-ios-simulator**. Its matching remote
  branch was absent at the initial read-only check; none has been pushed.
- npm is not the selected release source. Do not run `npm publish`.

## Prepared files

`marketplace/entries/ios-simulator.json`, the vendored SVG icon under
`marketplace/icons/`, and `marketplace/overview/ios-simulator.md` follow the
current community v2 contract. The overview is copied from the plugin's
`PLUGIN_OVERVIEW.md`.

The current marketplace was read from its default branch at commit
`92aa56203ec26369bbf1ba05028bade5fe3a5606`. Its full-history local validation
checkout is `/tmp/bb-ios-marketplace-review` (temporary, not a release source).
The inspected contract includes README, the v2 schema, category list, icon
rules, and two current entries. A local-only draft commit in that temporary
checkout is `852fd8e5f0584644cd119af73e0efea7e40d3a9d`, containing only the
entry, icon, and overview. Its `origin` is the official upstream repository;
do not push it there. Use the submitter fork for any approved submission.

## Checks and remaining work

- Exact runtime dependency `serve-sim: 0.1.48` and root lockfile agree.
- Published npm tarball source and SHA-1 were verified. Apache-2.0 attribution,
  node-swift/node-gyp licenses, source modification notice, locked build
  dependencies, and native reproduction steps are included.
- Native capture module rebuilt successfully on Xcode 27 and its ad-hoc
  signature verified. The UIKit clipboard helper built successfully and
  passed three live Unicode/multiline clipboard round trips. Their SHA-256
  values and targets are in `native/BUILD_METADATA.json`.
- Nine focused native-installer tests pass, including mismatched versions,
  missing/invalid manifests, missing targets, and restoration safety.
- Current marketplace v2 entry schema, reserved ID check, categories, icon,
  and overview validators pass. All 43 marketplace tests and its upload retry
  tests pass.
- **A real BB screenshot is still required.** Computer Use returned
  "Computer Use was not approved to use bb". No BB screenshot was captured or
  invented. The draft entry deliberately has an empty screenshots array;
  do not submit it that way. Capture the installed panel/header with real
  app content, at least 1200 pixels wide, at most 2 MiB, without private paths
  or conversation text. Put it under `screenshots/ios-simulator/` and add its
  exact relative path to the entry.
- **Full marketplace build and v1 gate pass.** After the authorized local-only
  draft commit supplied the required first-addition date, `npm run build`
  generated both documents with 384 entries. `npm run gate:v1` passes: the
  single new entry needs no v1-change exception. The build reports one
  unrelated unchanged entry without a category. The proposed source is unpublished (GitHub returns404), so its source
  liveness check cannot pass until the approved public repository and tag
  exist. The broad `npm run check` was stopped after it began checking all
  384 entries; the current script has no plugin filter (only `--liveness`
  and `--ranking`). It is not recorded as passed. Add the real screenshot to a new local commit and
  repeat the marketplace checks before submission.
- **Live Android verification is pending.** This host has no Android SDK or
  AVD. Its initial path uses serialized PNG polling, not video.
- The final root verification reports **82 passing plugin tests across
  12 files**, successful TypeScript checking, `bb plugin build`, and plugin
  reload. A live Truffle screenshot confirms Unicode text insertion. Record
  the final release commit separately before approval.
- Confirm both `native/serve-sim-native.node` and
  `native/simulator-pasteboard`, their source, and their notices are included
  in the final Git commit. Build caches, node_modules, and dist stay ignored
  in Git; BB builds a Git source install. The current source npm pack omits
  dist, so this is not an npm publication candidate.

## Performance verification conditions

The automated page-phase benchmark measured static capture at **6.7 fps and
21 KiB/s**, and animation at **53.1 fps and 136 KiB/s**. Animation frame gaps
had a **16 ms median**, **25 ms 90th percentile**, and **two stalls longer than
120 ms during an 8-second sample**.

This was a loaded-host result: system load was **26–38** and existing alignment
workers remained busy. The requested quiet-host retest has **not** been
fulfilled. No user's worker processes were stopped to manufacture a quiet
sample. Repeat the benchmark when the Mac is quiet before making a quiet-host
performance claim.

## Commands requiring release approval

The submit-a-plugin workflow requires approval before the first release
mutation. Show the exact full commit SHA, account, repository, version, tag,
source range, and commands together. Replace the commit placeholder below
with that approved SHA; never approve a moving `HEAD` implicitly.

From the plugin checkout, after the final local commit and checks:

```sh
gh repo create peteabu/bb-plugin-ios-simulator --public --source . --remote origin
git tag -a v0.1.0 FULL_APPROVED_COMMIT_SHA -m 'Release v0.1.0'
git push -u origin main
git push origin v0.1.0
```

Read-only verification after the push:

```sh
git ls-remote --tags https://github.com/peteabu/bb-plugin-ios-simulator.git
```

For the marketplace, use a fresh full-history checkout of the existing fork,
add `upstream` for `https://github.com/get-bb/marketplace.git`, create
`submit-ios-simulator` from current upstream/main, and copy only the entry,
icon, real screenshots, and overview. Make the local submission commit.
Run `npm ci --ignore-scripts`, `npm run build`, `npm test`, `npm run gate:v1`,
`npm run check`, and `git diff --check` before approval for its publication.
Then the remote commands are:

```sh
git push -u origin submit-ios-simulator
gh pr create --repo get-bb/marketplace --base main \
  --head peteabu:submit-ios-simulator --title 'Add plugin entry: ios-simulator' \
  --body-file /ABSOLUTE/PATH/marketplace-pr-body.md
```

The marketplace pull request must contain only its entry, icon, real
screenshots, and overview. It must state the selected release source,
actual plugin and marketplace validation results, local runtime requirements,
what each screenshot shows, and that the overview came from the plugin repo.
