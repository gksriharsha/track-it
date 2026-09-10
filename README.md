# TrackIt

A nutrition tracker that runs entirely on your own machine. Desktop (macOS) and
Android from one codebase: Tauri 2 shell, React 19 + TypeScript front end, and a
pure-Rust core that owns every nutrient number.

Nothing about your food log leaves the device. Reference data is a read-only
SQLite file bundled with the app, built from the USDA bulk downloads; your own
entries live in a separate SQLite file that reference-data updates never touch.

## Design rules worth knowing before reading the code

- **A nutrient value is a tagged union, never a nullable float.** "Not measured"
  and "zero" are different things, and no DTO carries `null` — `serde_json` turns
  NaN into `null` and JavaScript turns `null` into `0`, so the wire value that
  would enable that bug simply does not exist.
- **No arithmetic on a nutrient field in JavaScript.** Rust returns normalised
  geometry (percentages) and pre-formatted tick labels; the front end draws what
  it is given.
- **Logged history is immutable.** An entry keeps the nutrition it had when it was
  logged; editing a food or a recipe only affects future logs.
- **A recipe is a proportion, not a batch.** A recipe holds ingredients and their
  ratios, a *cook* is a finalised recipe, and what you log is a portion of a cook.

The full reasoning lives in [`docs/`](docs/) — read
[`docs/decisions.md`](docs/decisions.md) first (it supersedes the earlier
architecture drafts where they disagree), then
[`docs/data-findings.md`](docs/data-findings.md) for the empirical basis.

## Layout

| Path | What it is |
|---|---|
| `crates/core` | Pure Rust domain logic — nutrient math, DRI comparison, panels, labels, aggregation. No `tauri` dependency, unit-testable in about a second. |
| `src-tauri` | Thin adapter: SQLite access, IPC commands, on-device vision, platform glue. |
| `src` | React front end — screens, components, and the typed bridge to Rust. |
| `tools/build_reference_db.py` | Builds the bundled USDA reference database from the bulk CSVs. |
| `docs` | Architecture, data findings, and the decision register. |
| `design` | Standalone design canvases and UX explorations (open the HTML files directly). |

## Running it

Prerequisites: Node (see `.nvmrc`), pnpm, a Rust toolchain, and Python 3 for the
reference-database build. Android additionally needs the SDK, NDK, and JDK 17.

```bash
pnpm install
```

The bundled reference database is not in the repository — it is 37 MB and fully
regenerable. Two commands produce it, and they are the same two CI runs:

```bash
./tools/fetch_usda.sh
```

```bash
python3 tools/build_reference_db.py
```

Front end only, against mock data:

```bash
pnpm dev
```

The desktop app:

```bash
pnpm tauri dev
```

A release APK. The four exports are not optional and the build fails without
them: the log is SQLCipher-encrypted on Android, which vendors OpenSSL, and
openssl-src looks for `aarch64-linux-android-ranlib` — a name no NDK has shipped
since r23, where it became `llvm-ranlib`.

```bash
export NDK_BIN="$ANDROID_HOME/ndk/29.0.14206865/toolchains/llvm/prebuilt/darwin-x86_64/bin"
export CC_aarch64_linux_android="$NDK_BIN/aarch64-linux-android24-clang"
export AR_aarch64_linux_android="$NDK_BIN/llvm-ar"
export RANLIB_aarch64_linux_android="$NDK_BIN/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
pnpm android:apk
```

Note that `cargo check --target aarch64-linux-android` can pass without them, so
it is not a substitute for building the APK: a debug profile may reuse an OpenSSL
that is already built, and the failure is release-only.

## Continuous integration

`main` is protected: direct pushes are rejected, so every change arrives through a pull request.
Each pull request runs the tests and builds all three platforms; every merge to `main` does the
same and publishes the bundles as a GitHub prerelease. The macOS bundle is
ad-hoc signed and the Android APK unsigned until signing secrets are configured, and iOS builds
but is not yet packaged — [`docs/ci.md`](docs/ci.md) explains all three and what each one needs.

## Status

Early. Version 0.1.0, single-user, and built for one person's actual daily use
rather than for general release.
