# Continuous integration

One workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml), covers both
halves of "every branch merged to main gets release builds":

- **On a pull request against `main`** it runs the tests and builds all three platforms, so a
  bundle that no longer packages is visible before the merge button rather than after it.
  Pushing to the branch again cancels the previous run.
- **On the merge itself** the same jobs run again against the merge commit, and a `release` job
  publishes the results as a GitHub prerelease. Runs on `main` are never cancelled, because each
  one produces a release.

Tag: `v<version>-build.<run number>`, with `<version>` read from `src-tauri/tauri.conf.json`.
The run number keeps merges distinct without anyone bumping a file by hand, so `0.1.0` can stay
where it is until there is a reason to change it.

## `main` is protected

Direct pushes to `main` are rejected by a repository ruleset. Every change arrives through a pull
request, and the merge is what triggers a release.

| Rule | Effect |
|---|---|
| `pull_request` | No direct pushes. Zero approvals required, so a solo author can self-merge. |
| `required_status_checks` | `Tests`, `Android APK` and `macOS app` must pass, and the branch must be up to date with `main`. |
| `non_fast_forward` | No force-pushes. |
| `deletion` | `main` cannot be deleted. |

Zero required approvals is deliberate rather than lax: GitHub will not let anyone approve their
own pull request, so on a single-author repository requiring one would make every pull request
permanently unmergeable. The gate here is the pipeline, not a second pair of eyes.

`iOS app` is deliberately **not** a required check, matching the way the `release` job treats it —
see the iOS section below for why.

Requiring the branch to be up to date means a merge invalidates every other open pull request and
forces it to rebase and re-run. That is the intended trade: nothing reaches `main` having only
been tested against an older tree. It costs a full pipeline run per merge when several branches
are open at once.

```bash
git checkout -b some-change
```

```bash
git push -u origin some-change && gh pr create --fill
```

The pipeline takes several minutes, so let the merge wait on it rather than watching:

```bash
gh pr merge --auto --squash --delete-branch
```

## Job graph

```
meta ─────────────────────────┐
                              │
reference-db ─→ test ─→ ┌─ android ─┐
                        ├─ macos   ─┼─→ release   (only on push to main)
                        └─ ios     ─┘
```

Everything waits on `reference-db`, including the tests: `tauri-build` validates every path in
`tauri.conf.json`'s `bundle.resources` before it will compile `src-tauri` at all, so without the
database on disk not even `cargo test` gets as far as a test.

`test` runs on macOS because that is the only runner that compiles the `cfg(target_os = "macos")`
half of `vision.rs`, where the Apple Vision adapter lives. 157 core tests plus 146 adapter tests.

`reference-db` exists because `usda_core.db` is a declared bundle resource — **no platform can
package without it** — while being 37 MB, generated, and therefore not in the repository. The job
runs `tools/fetch_usda.sh` (13 MB of pinned archives, verified against `tools/sources.sha256`)
then `tools/build_reference_db.py`, and hands the result to the three platform jobs as an
artifact. It is cached on the hash of those three files, so a normal run restores it in seconds
and only a change to how the database is produced rebuilds it.

## What comes out

| Asset | Signing |
|---|---|
| `TrackIt-<v>-macos-aarch64.dmg`, `…app.zip` | Ad-hoc by default |
| `TrackIt-<v>-android-arm64.apk` | Unsigned by default |
| `TrackIt-<v>-ios.ipa` | Only produced once Apple secrets exist |

Apple Silicon only on macOS. A universal binary means compiling everything twice, and with
`lto = true` and `codegen-units = 1` in the release profile that is a real cost for a second
architecture nobody here runs. Change `MACOS_TARGET` in the workflow to `universal-apple-darwin`
if that stops being true.

## Signing

Everything below is optional. Without any of it the pipeline still runs green and still produces
bundles — they are just bundles that only install with a manual override.

### macOS — ad-hoc today

`tauri.conf.json` sets `signingIdentity: "-"`, so CI produces an ad-hoc signed bundle with no
secrets at all. It runs on the machine that built it and, after right-click → Open, on your own
Mac. Gatekeeper will refuse it on anyone else's.

For a bundle that opens normally anywhere, add a Developer ID certificate and notarisation
credentials as repository secrets — `APPLE_CERTIFICATE` (base64 `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. The build step already passes them through; no
workflow edit is needed.

### Android — unsigned today

An unsigned release APK cannot be installed **at all** — not over an existing install, not onto
a clean device, not by you. Android refuses it outright (`apksigner verify` reports
`Missing META-INF/MANIFEST.MF`), so until these secrets exist every published `.apk` is a file
nobody can use. The release job names such a build `-UNSIGNED` and says so in the notes rather
than offering it under a name that looks installable.

Generate an upload key **and keep the file** — losing it means never being able to update an
installed app:

```bash
keytool -genkeypair -v -keystore upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

Then add four repository secrets:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | the key password |

CI writes them to `gen/android/keystore.properties`, which the guarded `signingConfigs` block in
`app/build.gradle.kts` picks up, and deletes both afterwards. The block is a no-op locally, where
the file does not exist. The keystore itself must never be committed — `.gitignore` covers
`*.jks`, `*.keystore` and `keystore.properties`.

### iOS — the honest position

**An installable `.ipa` is not achievable without a paid Apple Developer Program membership.**
Export needs a distribution certificate and a provisioning profile issued against a team, and no
flag substitutes for them. Two further things are true today:

- `src-tauri/gen/apple` does not exist. CI generates the Xcode project with `tauri ios init` on
  the fly, which is fine, but nobody has run an iOS build yet.
- `vision.rs` has adapters for macOS (Apple Vision) and Android (ML Kit) only. iOS falls into the
  `not(any(macos, android))` branch, so **label and barcode scanning would be inert on iOS** even
  once it ships. Apple's Vision framework is available on iOS; wiring it up is mostly widening
  the `cfg` gate and moving `objc2-vision` out of the macOS-only dependency table, but it is real
  work that has not been done.

The `aarch64-apple-ios` build is green on CI, so the Rust side genuinely compiles for a device.
It cannot be reproduced on the development machine, which has Apple's Command Line Tools but not
Xcode and therefore no iPhoneOS SDK — `cargo build --target aarch64-apple-ios` there does not get
past `objc2-exception-helper`'s build script. Building iOS locally means installing full Xcode
first; until then CI is the only place it is exercised.

Because of that, the `release` job treats `android` and `macos` as hard requirements and iOS as
non-blocking: a failing `ios` job still fails the run and still shows on the commit, but it does
not stop two working bundles from being published. Promote it to a hard requirement once it has
been green a few times.

So the `ios` job always does the part that needs no account — building the whole Rust side for
`aarch64-apple-ios`, which is where an iOS regression would actually surface — and skips
packaging with a note in the run summary. Supply `APPLE_TEAM_ID`, `IOS_CERTIFICATE`,
`IOS_CERTIFICATE_PASSWORD` and `IOS_MOBILE_PROVISION` and the same job additionally produces and
uploads an `.ipa`, signing inside a throwaway keychain that is created for that run only. Set the
`IOS_EXPORT_METHOD` repository variable to choose `debugging`, `release-testing`,
`app-store-connect` or `enterprise`; it defaults to `debugging`.

## Building the reference database yourself

The same two commands CI runs:

```bash
./tools/fetch_usda.sh
python3 tools/build_reference_db.py
```

`fetch_usda.sh` is idempotent and verifies every archive against `tools/sources.sha256`. Those
digests are pinned deliberately: USDA has re-cut a release under an unchanged filename before,
and the database is only reproducible against these exact bytes. If verification fails, the
source moved — decide what the new data means before updating the digests.
