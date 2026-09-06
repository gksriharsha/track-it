> **⚠️ DRAFT — partially SUPERSEDED.** This document was written before an adversarial
> completeness pass, which found 22 defects by running its DDL and SQL against the real USDA data
> (see `architecture-critique.md`). Where this file conflicts with **`decisions.md`**, `decisions.md`
> wins — it resolves the blocking defects, including the portion math, the nutrient value type, the
> negative source amounts, the un-insertable "no UL established" row, and the rollup/trend spines.
> Read `decisions.md` first.

# TrackIt — Application Architecture

Status: decided. Target date 2026-09-03. Host verified: macOS 26.6 arm64, Node 26.3.0, pnpm 10.28.2,
rustc 1.98.1 (rustup, PATH-ahead of Homebrew rust 1.96.0), NDK 29.0.14206865, SDK platforms 33 + 36,
build-tools 35.0.0, JDK 17 Zulu, tauri 2.11.5 / tauri-build 2.6.3 / tauri-cli 2.11.4 / tao 0.35.3 /
wry 0.55.1, vite 7.3.6, @vitejs/plugin-react 4.7.0, react 19.2.8, typescript 5.8.3,
@tauri-apps/api 2.11.1.

Read `docs/data-findings.md` first — it is the empirical basis for every correctness rule below.
The reference-database DDL and the USDA ingest rules live in `docs/architecture-data.md`; this
document owns the *application*: what runs where, what crosses IPC, and in what order it gets built.

**The one-sentence architecture.** A pure-Rust core crate owns every nutrient number and every
comparison; `src-tauri` is a thin adapter that serialises the core's tagged types; React receives
values it cannot read without narrowing and geometry it cannot compute itself, and therefore cannot
turn "not measured" into "0".

---

## 0. Decision register

| # | Decision | Rationale (short) |
|---|---|---|
| D1 | Pure-Rust `crates/core`, zero `tauri` dependency | Domain logic unit-testable in ~1 s with no webview, no Android, no bundler |
| D2 | **rusqlite 0.40 (bundled)**, no `tauri-plugin-sql` | `links = "sqlite3"` is exclusive; plugin-sql's decoder collapses failures to `null` and its untyped `select<T>` is the exact hole this app must not have |
| D3 | Two SQLite files: `usdacore.db` (read-only, replaced wholesale) + `user.db` (WAL), plus disposable `cache.db` | "Ship new reference data without touching user data" becomes structurally impossible to get wrong |
| D4 | **No `null` anywhere in any DTO.** Every optional-shaped value is a serde-tagged enum | `serde_json` maps NaN/∞ → `null`; JS maps `null` → `0`. Remove the wire value and the failure mode has nowhere to live |
| D5 | Rust returns **normalised geometry** (percentages) and **formatted tick labels**, not raw numbers, to every chart and bar | Makes "no arithmetic operator may touch a nutrient field in JS" a rule with no exceptions |
| D6 | **No charting library.** Hand-rolled SVG over Rust-supplied percentages | The required mark (solid lower bound + hatched uncertainty + open unbounded edge) exists in no library; visx 4.0.0 stays named as a lazy-loaded escape hatch |
| D7 | Plain **history routing** (not hash) | Tauri's asset protocol *does* have an `index.html` SPA fallback (verified in released tags); wry wires the Android back gesture to `WebView.goBack()`, so history-backed routing is mandatory but hash is not |
| D8 | **Direct `reqwest`**, no `tauri-plugin-http` | The webview never fetches; the plugin's only value is a CORS-free `fetch` for JS. Dropping it removes an ACL scope we would otherwise have to get right |
| D9 | No `tauri-plugin-store`, no `tauri-plugin-os` | Settings live in `user.db`; the FDC API key must never cross IPC; platform comes from `cfg!` inside `app_status` |
| D10 | Barcode scanner target-gated to `cfg(mobile)`, desktop gets validated manual GTIN entry | Plugin support level on macOS is literally `none`; a WebView `getUserMedia` route needs a hand-written `WebChromeClient` and a WASM fallback for zero gain |
| D11 | `useHttpsScheme: true` set **before** the first release build | One-way door: flipping it later relocates localStorage/IndexedDB/cookies and orphans existing data |

Where this document overrides a research track, it says so in §11.

---

## 1. The Rust / React split

### 1.1 The line

| Belongs to Rust (`crates/core`) | Belongs to React |
|---|---|
| Unit conversion (g ↔ mg ↔ µg only; **IU is refused, never converted**) | Layout, colour, type, motion |
| Portion → grams, including `quantity × gram_weight / portion.amount` (FDC's `amount` is often 3, not 1) | Mapping a Rust-supplied percentage to a CSS width |
| Per-100 g → per-serving scaling | Display rounding of a value Rust has already declared final |
| Recipe expansion, nesting depth, yield scaling, cooking-loss policy | Sorting/filtering opaque lists by keys Rust supplied (`rank`, `severity`) |
| Summation into `[lower, upper]` intervals + coverage | Form state *before* submit (strings, never numbers) |
| %RDA / %UL and the three-valued verdict | Which section is expanded, which date is selected |
| Life-stage resolution (birthdate + today → DRI group) | Focus, scroll, gesture, animation |
| The local calendar day | — |
| Parsing every user-typed quantity string | — |
| Source normalisation (OFF grams-vs-milligrams; the 1008→2047→2048 energy chain) | — |

**Hard rule.** No arithmetic operator (`+ - * / %`), no `Math.*`, no `Number()`, no `parseFloat`,
no `.reduce`, and no comparison operator may be applied to a nutrient quantity in TypeScript —
ever, anywhere. This is enforceable only because of D5: Rust hands the UI percentages and strings,
so there is nothing left to compute.

### 1.2 The value type

There are **two** types, and conflating them is the bug this whole app exists to avoid.

```rust
// crates/core/src/value.rs

/// A single food's value for a single nutrient. Never a float, never an Option.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/bindings/")]
pub enum NutrientValue {
    /// A real analytical or calculated number. `derivation` carries FDC's code.
    Measured { amount: f64, unit: Unit, derivation: Derivation },
    /// Reported as `< loq`. True value lies in [0, loq). Only reachable from the live
    /// FDC per-food API or an OFF `<` modifier — the bulk downloads have no LOQ column.
    BelowLoq { loq: f64, unit: Unit },
    /// A label value rounded to zero under FDA rounding rules. True value in [0, upper].
    LabelRoundedZero { upper: f64, unit: Unit },
    /// No row exists in any source. Carries no number at all — that is the point.
    Absent,
}
```

There is deliberately **no** `Unknown { amount: Option<f64> }` and **no** shared `amount` field
hoisted out of the variants. `Absent` has no numeric field, so the generated TypeScript makes
`v.amount` a compile error until `v.kind === "measured"` narrows it — and therefore makes
`v.amount ?? 0` a compile error too, because the property does not exist on the union.

`Measured` is constructible only through a checked constructor:

```rust
impl NutrientValue {
    pub fn measured(amount: f64, unit: Unit, derivation: Derivation) -> Result<Self, ValueError> {
        if !amount.is_finite() { return Err(ValueError::NonFinite); } // serde_json → null → 0
        if amount < 0.0        { return Err(ValueError::Negative); }
        Ok(Self::Measured { amount, unit, derivation })
    }
}
```

The fields are `pub` for pattern matching but the enum lives in a module whose only public
constructors are checked; a `#[non_exhaustive]`-style guard is unnecessary because `serde`
deserialisation of `NutrientValue` is never performed on untrusted input (it only ever flows
Rust → TS).

### 1.3 The aggregate type — where the lower/upper asymmetry lives

A day total is **an interval plus coverage**, because "am I deficient?" reads the bottom of the
interval and "am I over the safe limit?" reads the top.

```rust
#[derive(Debug, Clone, Serialize, TS)]
pub struct Coverage {
    pub items_total:    u32,   // log entries that could contribute
    pub items_measured: u32,   // entries with a Measured value
    pub items_bounded:  u32,   // entries with BelowLoq / LabelRoundedZero
    pub items_absent:   u32,   // entries with no row at all
    pub grams_total:    f64,   // mass basis — 4-of-5 items hides that the 5th was 400 g of 500 g
    pub grams_measured: f64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpperBound {
    /// Every contributing item was measured or bounded: the true total cannot exceed this.
    Bounded { amount: f64 },
    /// At least one contributing item was Absent — the true total has no computable ceiling.
    Unbounded,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct NutrientTotal {
    pub nutrient_id: NutrientId,
    pub unit:        Unit,
    pub lower:       f64,        // Σ of Measured amounts only. "At least this much."
    pub upper:       UpperBound, // lower + Σ of bounded uppers, or Unbounded.
    pub coverage:    Coverage,
}
```

`lower` is a plain `f64` and that is safe: the sum of zero measured items is a *genuine* 0 lower
bound ("we know of at least 0 µg"), not a manufactured zero. What makes it honest is that it is
never displayed alone — see §1.4 and §7.

### 1.4 Verdicts are interval comparisons

Comparing an interval to a threshold is three-valued, not two-valued. This is the whole reason
one scalar cannot answer both questions.

```rust
#[derive(Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Verdict {
    CertainlyBelow,      // upper  < threshold
    Indeterminate,       // interval straddles the threshold
    CertainlyAtOrAbove,  // lower >= threshold
    NoTargetEstablished, // e.g. UL for thiamin, riboflavin, B12, pantothenate, biotin
}
```

| Question | Threshold | Reads | Legal conclusions |
|---|---|---|---|
| Am I deficient? | RDA or AI | `lower` for "met", `upper` for "certainly short" | `lower ≥ RDA` ⇒ **met, certain, regardless of coverage**. `upper < RDA` ⇒ **short, certain**. Otherwise **indeterminate** — never rendered as "you are deficient" |
| Am I over the safe limit? | UL | `lower` for "certainly over", `upper` for "%UL display" | `lower > UL` ⇒ **over, certain, regardless of coverage**. The displayed %UL uses `upper` so risk is never under-reported. `Unbounded` upper ⇒ %UL is not displayed at all |

Two footnote rules from `data-findings.md` that live in `targets.rs`, not in the UI:

- The vitamin A UL (3,000 µg/day) applies to **preformed retinol** (FDC 1105 Retinol), not to
  total RAE (1106). A UL comparison against RAE is a bug that warns carrot eaters.
- Folate UL = folic acid only; niacin and vitamin E ULs = synthetic forms only; magnesium UL =
  supplemental only. Each of these targets carries a `basis: TargetBasis` discriminating which
  nutrient id the comparison must read, and the verdict function refuses to compare a target to a
  nutrient whose id is not in its basis set.
- Chromium and biotin have **AIs, not RDAs**. `TargetKind::{Rda, Ai, Ul, Cdrr}` is on the wire and
  the UI label is derived from it; an AI is never rendered as "RDA".

### 1.5 Geometry crosses IPC, not numbers (D5)

The bar in §7 needs `width: X%`. Computing `X = lower / scale_max` in JS is nutrient arithmetic.
So Rust computes it:

```rust
#[derive(Serialize, TS)]
pub struct BarGeometry {
    pub lower_pct: f64,           // 0..100, solid segment
    pub upper_pct: f64,           // 0..100, right edge of the hatched segment (== lower_pct if exact)
    pub unmeasured_mass_pct: f64, // 0..100 width of the "open edge" wedge when upper is Unbounded
    pub target_tick_pct: f64,     // where RDA/AI lands on the track (constant across nutrients)
    pub ul_marker: UlMarker,      // At { pct } | NotEstablished
    pub label: String,            // "≥34 µg", "34–41 µg", "—", already formatted in Rust
    pub a11y_label: String,       // "selenium, at least 34 micrograms, 2 of 5 foods measured, …"
}
```

React writes `style={{ width: `${g.lower_pct}%` }}`. That is string interpolation, not arithmetic.
The same trick makes the trends chart library-free (§6.4).

### 1.6 Preventing `?? 0` — six independent layers

| Layer | Mechanism | Fails at |
|---|---|---|
| 1. Type shape | `amount` exists only inside `kind: "measured"`; `?? 0` on it is `TS2339` | compile |
| 2. No nulls on the wire | `#![forbid]`-by-convention on `Option<T>` in DTOs; CI greps `src/bindings/*.ts` for `\| null` and fails | CI |
| 3. Non-finite guard | `NutrientValue::measured()` rejects NaN/±∞ before `serde_json` can write `null` | runtime + unit test |
| 4. Serialisation corpus test | Serialise a fixture corpus of every DTO; assert the JSON contains no `null` token | `cargo test` |
| 5. ESLint | `no-restricted-syntax` on `??`/`||` with a `0` literal, and on `Number(`/`parseFloat(` under `src/nutrition/**` | lint |
| 6. SQL/Rust grep gate | Reject `total(`, `ifnull(sum`, `coalesce(sum`, `unwrap_or(0`, `unwrap_or_default()` on float paths | CI |

Plus one deliberate **negative compile test** committed in Phase 0: `src/__typetests__/no-silent-zero.ts`
contains `// @ts-expect-error` lines asserting that `v.amount`, `v.amount ?? 0` and
`total.upper.amount` (without narrowing `kind`) all fail to typecheck. If someone flattens the union
into a nullable float, that file starts *passing* and `tsc` errors on the unused `@ts-expect-error`.

Layer 6 rationale, verified on this host:
`sqlite3 :memory: "select sum(v), total(v) from (select null as v union all select null);"` prints
`|0.0` — `sum()` returns NULL, `total()` returns 0.0. And `SUM()` skips NULL rows entirely, so a
day's selenium over 5 foods where 3 lack a measurement silently reports the 2-food subtotal as the
day's intake. Every aggregate in this codebase is written as
`sum(x) AS total, count(x) AS n_measured, count(*) AS n_rows, sum(grams) AS g_total`.

---

## 2. Crate layout

**Yes, split.** `crates/core` has no `tauri` dependency, which means (a) `cargo test -p trackit-core`
runs in about a second with no webview, no NDK, no bundler; (b) it is *impossible* for domain code to
reach for an `AppHandle`, emit an event, or read a config — so the arithmetic stays pure and
property-testable; (c) the ingest tool and the app share one implementation of unit conversion and
value semantics, so the DB can never be built under different rules than it is read under.

```
/Users/kgundu1/BioBalance/
├── Cargo.toml                          # [workspace] members = ["src-tauri", "crates/*"]
├── Cargo.lock                          # moves up from src-tauri/ — one lockfile for the workspace
├── package.json  pnpm-lock.yaml  vite.config.ts  tsconfig.json  index.html
│
├── crates/
│   ├── core/                           # trackit-core — NO tauri, NO tokio, NO reqwest
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── units.rs                # Unit enum; g/mg/µg conversion; IU refused, not guessed
│   │       ├── value.rs                # NutrientValue, NutrientTotal, Coverage, UpperBound
│   │       ├── verdict.rs              # interval↔threshold → Verdict; the UL basis rules
│   │       ├── targets.rs              # DRI table, life-stage resolution from birthdate + date
│   │       ├── portion.rs              # quantity × gram_weight / portion.amount
│   │       ├── recipe.rs               # recursive expansion, depth cap 5, yield scaling
│   │       ├── rollup.rs              # entries → Vec<NutrientTotal>; the coverage-aware fold
│   │       ├── geometry.rs             # BarGeometry, TrendGeometry, tick labels (D5)
│   │       ├── format.rs               # the ONLY place a number becomes a display string
│   │       ├── time.rs                 # local calendar day, day boundaries, tz handling
│   │       ├── dto.rs                  # the IPC contract; #[derive(TS)] on everything
│   │       ├── error.rs                # CoreError — tagged, no strings-as-errors
│   │       └── db/
│   │           ├── mod.rs              # open flags, pragmas, connection construction
│   │           ├── reference.rs        # read-only usdacore.db queries
│   │           ├── user.rs             # user.db reads/writes
│   │           ├── cache.rs            # cache.db (FDC/OFF responses)
│   │           ├── migrations.rs       # rusqlite_migration over PRAGMA user_version
│   │           └── search.rs           # FTS5
│   │
│   ├── usda-ingest/                    # bin — dev-only, never shipped in either bundle
│   │   ├── Cargo.toml                  # depends on trackit-core for unit/value semantics
│   │   └── src/main.rs                 # data/raw/extracted/** → src-tauri/resources/usdacore.db
│   │
│   └── net/                            # trackit-net — reqwest; FDC + Open Food Facts clients
│       ├── Cargo.toml                  # normalises OFF g-vs-mg and absent-vs-zero into NutrientValue
│       └── src/lib.rs
│
├── src-tauri/                          # thin adapter ONLY
│   ├── Cargo.toml
│   ├── build.rs                        # tauri_build::build() + bakes USDA_CORE_SHA256
│   ├── tauri.conf.json
│   ├── capabilities/{default.json, mobile.json}
│   ├── resources/usdacore.db           # GITIGNORED, regenerable; hash pinned in usdacore.lock.json
│   ├── resources/usdacore.lock.json    # COMMITTED: {dataset_version, sha256, row_counts}
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs                      # Builder, plugins, setup(), state
│   │   ├── state.rs                    # AppState { user: Mutex<Connection>, reference: Mutex<Connection>, … }
│   │   ├── seed.rs                     # copy-on-first-run + integrity + update detection (§4.3)
│   │   ├── error.rs                    # AppError: CoreError + adapter errors, serde-tagged
│   │   └── commands/
│   │       ├── mod.rs                  # generate_handler! list
│   │       ├── status.rs  foods.rs  log.rs  dashboard.rs
│   │       ├── recipes.rs  targets.rs  profile.rs  online.rs  trends.rs
│   └── gen/android/                    # COMMITTED (see §5.4)
│
├── src/                                # React
│   ├── bindings/                       # ts-rs OUTPUT — generated, committed, CI-verified
│   ├── ipc/                            # typed invoke wrappers; the only import of @tauri-apps/api
│   ├── nutrition/                      # NutrientAmount, IntervalBar, VerdictGlyph, CoverageChip
│   ├── screens/  components/  shell/  state/  styles/
│   └── __typetests__/no-silent-zero.ts
│
├── data/raw/                           # gitignored USDA bulk downloads (present)
└── docs/{data-findings.md, architecture-data.md, architecture-app.md}
```

Root `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["src-tauri", "crates/core", "crates/net", "crates/usda-ingest"]

[workspace.package]
edition = "2021"
rust-version = "1.77.2"        # Tauri 2.11 MSRV; host is 1.98.1

[workspace.dependencies]
trackit-core = { path = "crates/core" }
serde      = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite   = { version = "0.40", features = ["bundled", "functions", "window", "array", "backup", "cache", "column_decltype"] }
rusqlite_migration = "2.6"
uuid       = { version = "1", features = ["v7", "serde"] }
sha2       = "0.10"
ts-rs      = "12"
thiserror  = "2"
```

`crates/core/Cargo.toml` — note what is *absent*:

```toml
[dependencies]
serde.workspace = true
rusqlite.workspace = true
rusqlite_migration.workspace = true
uuid.workspace = true
thiserror.workspace = true
ts-rs.workspace = true
# NOT here, on purpose: tauri, tauri-plugin-*, tokio, reqwest, log
[dev-dependencies]
proptest = "1"
```

`src-tauri/Cargo.toml` (delta from the scaffolded file — the `[lib] name = "trackit_lib"` and
`crate-type = ["staticlib","cdylib","rlib"]` stanza stays exactly as generated):

```toml
[dependencies]
tauri = { version = "2.11.5", features = [] }
tauri-plugin-opener = "2.5.5"
tauri-plugin-fs     = "2.5.2"        # Rust-side only, for asset:// open. No npm binding.
tauri-plugin-log    = "2.9.1"
trackit-core.workspace = true
trackit-net = { path = "../crates/net" }
serde.workspace = true
serde_json.workspace = true
sha2.workspace = true
thiserror.workspace = true
tokio = { version = "1", features = ["rt", "sync"] }

[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]
tauri-plugin-barcode-scanner = "2.4.6"
```

**ts-rs binding generation.** `#[ts(export, export_to = "../../../src/bindings/")]` on every DTO;
`cargo test -p trackit-core export_bindings` writes the `.ts` files. CI runs it then
`git diff --exit-code src/bindings/` so a Rust DTO change that was not regenerated fails the build.

**Verify the crate split is real:**
```bash
cd /Users/kgundu1/BioBalance && cargo tree -p trackit-core | grep -c '^tauri' # must print 0
cd /Users/kgundu1/BioBalance && cargo test -p trackit-core                     # must not build a webview
cd /Users/kgundu1/BioBalance && cargo tree -i libsqlite3-sys                      # must show exactly ONE version
```

---

## 3. The Tauri command surface

Coarse-grained and shaped. Never "run this SQL"; never "give me rows". Every command is
`async fn` whose body is `spawn_blocking`, so a 200 ms FTS query cannot stall the event loop.

```rust
#[tauri::command]
async fn get_day_dashboard(
    state: tauri::State<'_, AppState>,
    profile_id: ProfileId,
    day: LocalDate,             // opaque "YYYY-MM-DD" produced by today_local()
) -> Result<DayDashboard, AppError> {
    let db = state.clone_handles();
    tauri::async_runtime::spawn_blocking(move || core::dashboard::day(&db, profile_id, day))
        .await
        .map_err(AppError::from)?
        .map_err(AppError::from)
}
```

| Command | Signature (abbreviated) | Returns | Notes |
|---|---|---|---|
| `app_status` | `() -> AppStatus` | platform, app version, webview version, `barcode_available: bool`, reference `dataset_version`, `seed_state`, `schema_version`, `has_fdc_key: bool` | The startup gate. `has_fdc_key` is a boolean — the key itself never crosses IPC |
| `today_local` | `() -> LocalDate` | `"2026-09-03"` | JS must never derive a calendar day |
| `search_foods` | `(q: String, limit: u32, cursor: Option<Cursor>) -> FoodSearchPage` | local FTS5 hits in frozen rank order | Page size 50 |
| `search_foods_online` | `(q, page) -> OnlineSearchPage` | FDC/OFF hits | Separate command so results append **below a divider** and never merge-and-resort |
| `lookup_barcode` | `(gtin: Gtin) -> BarcodeLookup` | `Found(FoodSummary)` / `NotFound` / `NetworkUnavailable` | `Gtin` is a newtype validated in Rust: 8/12/13/14 digits + mod-10 |
| `get_food_detail` | `(food_id: FoodId) -> FoodDetail` | per-100 g `Vec<(NutrientId, NutrientValue)>`, portions, provenance | ~50 nutrients ≈ 6 KB |
| `log_entry` | `(req: LogEntryRequest) -> DayDashboard` | the **fresh** dashboard | Returning the dashboard is what makes optimistic JS updates unnecessary (§6.2) |
| `update_log_entry` / `delete_log_entry` | `(…) -> DayDashboard` | ditto | Soft delete (`deleted_at`) |
| `get_day_dashboard` | `(profile_id, day) -> DayDashboard` | entries + **all ~50** `NutrientRollup` | One atomic call. ≈ 10–14 KB |
| `get_nutrient_trend` | `(nutrient_id, from, to, profile_id) -> TrendSeries` | per-day interval + coverage + **pre-normalised geometry** | One nutrient per call; 365 days ≈ 30 KB |
| `create_custom_food` / `update_custom_food` | `(CustomFoodInput) -> FoodId` | | Amounts arrive as **strings**, parsed in Rust |
| `save_recipe` / `get_recipe` | `(RecipeInput) -> RecipeDetail` | per-serving `NutrientTotal` intervals | Depth > 5 or a cycle ⇒ `AppError::RecipeTooDeep` / `RecipeCycle` |
| `get_profile` / `save_profile` | `(…) -> Profile` | birthdate (never a stored age), sex, height, activity, pregnancy/lactation | |
| `get_targets` | `(profile_id, on: LocalDate) -> Vec<NutrientTarget>` | `{kind: Rda|Ai|Ul|Cdrr, basis, status}` | `status: Established{amount} | NotEstablished` — "no UL" can never render as "unlimited" |
| `set_fdc_api_key` | `(key: String) -> AppStatus` | | Write-only direction. There is no getter |
| `export_day_csv` | `(day) -> String` | CSV text | Phase 9; needs `tauri-plugin-dialog` |

### 3.1 Response budget

Hard cap: **64 KB per IPC response**. Above that, paginate. Measured reference points from the
research: a 10 MB payload is ~5 ms on macOS but ~200 ms on Windows, and maintainers state the
system-webview bridge cannot be improved much further. Nothing here approaches that; the budget
exists to keep it that way. Sending 30 days of raw log rows instead of an aggregate is roughly a
50× payload increase for the same screen — aggregate in Rust.

### 3.2 State and threading

```rust
pub struct AppState {
    pub user:      Arc<Mutex<rusqlite::Connection>>,   // single writer; WAL means readers don't block
    pub reference: Arc<Mutex<rusqlite::Connection>>,   // read-only, no CREATE bit
    pub cache:     Arc<Mutex<rusqlite::Connection>>,
    pub http:      trackit_net::Client,             // reqwest::Client is already cheap to clone
    pub seed:      SeedState,
}
```

`rusqlite::Connection` is `Send` but not `Sync`, hence `Mutex`. One connection per file is correct
for v1: writes are serialised anyway and WAL keeps the dashboard readable during a barcode write.
If concurrent search latency ever becomes visible, promote `reference` to
`r2d2::Pool<SqliteConnectionManager>` with `max_size = 2` — a local change behind `db/mod.rs`.

### 3.3 Errors

```rust
#[derive(Debug, Serialize, TS, thiserror::Error)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AppError {
    #[error("reference database not ready")]        ReferenceNotSeeded { detail: String },
    #[error("reference database integrity failure")] ReferenceCorrupt  { expected: String, actual: String },
    #[error("recipe nesting exceeds 5 levels")]      RecipeTooDeep     { depth: u32 },
    #[error("recipe contains a cycle")]              RecipeCycle       { food_id: String },
    #[error("cannot convert {from} to {to}")]        UnconvertibleUnit { from: String, to: String },
    #[error("quantity is not a number")]             UnparseableQuantity { input: String },
    #[error("network unavailable")]                  Offline,
    #[error("rate limited, retry after {secs}s")]    RateLimited { secs: u32 },
    #[error("internal error")]                       Internal { detail: String },
}
```

Never `Result<T, String>`: the UI branches on `code`, and a stringly-typed error means the UI
either shows raw Rust text or silently swallows it.

---

## 4. Data layer

### 4.1 rusqlite, not tauri-plugin-sql — and it is a one-time exclusive choice

`libsqlite3-sys` declares `links = "sqlite3"`. Cargo permits exactly one crate in the graph with a
given `links` key. `tauri-plugin-sql` 2.4.1 → `sqlx ^0.8` → `sqlx-sqlite 0.8.6` → `libsqlite3-sys ^0.30.1`.
`rusqlite 0.40.2` → `libsqlite3-sys ^0.38.2`. Semver-incompatible, same links key, **hard build error**.
There is no configuration that makes both work. (The escape hatch, `rusqlite 0.32.1` → `libsqlite3-sys 0.30.1`,
would pin us to a four-year-old rusqlite; not worth it.)

Given the choice is forced, correctness decides it:

| `tauri-plugin-sql` behaviour (verified in the published 2.4.1 crate) | Consequence for TrackIt |
|---|---|
| `plugins/sql/src/decode/sqlite.rs` maps **decode failures** to `JsonValue::Null` | A type-affinity surprise is indistinguishable from "not measured" |
| `commands::select` returns `Vec<IndexMap<String, JsonValue>>`; `select<T>()` in JS is an unchecked caller assertion | TS claims `number` while the runtime value is `null`; `Number(null) === 0` |
| `DbPool::connect` calls `Sqlite::create_database` when the file is missing (`create_if_missing(true)`), swallowing the check error with `.unwrap_or(false)` | A failed asset extraction yields a **silently empty** database instead of an error |
| `Pool::connect` with sqlx defaults: `max_connections: 10`, `after_connect: None` | `ATTACH` and per-connection PRAGMAs land on one arbitrary pooled connection and later vanish |
| sqlx does **not** set `journal_mode` (`pragmas.insert("journal_mode", None)`, with the comment "Don't set journal_mode unless the user requested it") | You get DELETE, not WAL, unless you issue it yourself |
| `MigrationSource::resolve` silently drops every Down migration | Rollback silently does nothing |

rusqlite gives full control of flags, pragmas, and the connection lifetime — and, decisively, keeps
raw SQL on the Rust side of the boundary where the type system can enforce §1.2. **No capability
ever grants `sql:allow-select` or `sql:allow-execute`, because the plugin is not installed.**

Runtime SQLite version: rusqlite 0.40 → libsqlite3-sys 0.38.2 bundles **3.51.3** — above FTS5 (3.9),
trigram tokenizer (3.34), RETURNING (3.35) and STRICT tables (3.37), and close enough to the host
CLI's 3.51.0 that benchmarks taken there transfer.

### 4.2 Three files, not one

| File | Location | Mode | Lifecycle |
|---|---|---|---|
| `usdacore.db` | `<app_data_dir>/reference/usdacore.db` | `SQLITE_OPEN_READ_ONLY \| SQLITE_OPEN_NO_MUTEX` | Extracted from the bundle; **replaced wholesale** on version bump |
| `user.db` | `<app_data_dir>/user.db` | RW, `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` | Migrated forward; never destroyed |
| `cache.db` | `<app_data_dir>/cache/cache.db` | RW, WAL | Disposable. Deleting it must be harmless |

The "two databases are dead on arrival" argument in the schema research is entirely a consequence
of `tauri-plugin-sql`'s unconfigurable pool. With rusqlite we own the connection, so `ATTACH` is
stable — but we still do not use it in hot paths, for a reason that survives the driver change:
**SQLite foreign keys cannot cross ATTACH boundaries**, so a cross-file `log_entries → ref_foods`
FK is impossible regardless.

The resolution is the same thing that solves three other problems at once: **snapshot nutrition at
log time**. When an entry is created, the per-100 g nutrient vector is written into `user.db` as an
immutable, content-addressed row (`sha256(source_kind, source_ref, dataset_version, sorted pairs)`).
Consequently:

- The dashboard and trends queries touch **only** `user.db`. No cross-file join, no ATTACH.
- Deleting `cache.db` cannot damage a logged branded food.
- A USDA refresh that removes an `fdc_id` cannot silently drop that food's historical contribution.
- Shipping new reference data cannot touch user data — they are different files.

`reference/` and `cache/` must be excluded from Android Auto Backup (25 MB per-app quota; a ~20 MB
reference DB would silently kill backup of the actual food log). A folder *named* `no_backup` under
`files/` is not Android's no-backup directory — you must declare the exclusion:

```xml
<!-- src-tauri/gen/android/app/src/main/res/xml/backup_rules.xml  (Android ≤ 11) -->
<full-backup-content>
  <exclude domain="file" path="reference/" />
  <exclude domain="file" path="cache/" />
</full-backup-content>
```
```xml
<!-- src-tauri/gen/android/app/src/main/res/xml/data_extraction_rules.xml  (Android 12+) -->
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="file" path="reference/" />
    <exclude domain="file" path="cache/" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="file" path="reference/" />
    <exclude domain="file" path="cache/" />
  </device-transfer>
</data-extraction-rules>
```
referenced from `<application android:fullBackupContent="@xml/backup_rules"
android:dataExtractionRules="@xml/data_extraction_rules">`.

### 4.3 Shipping the prebuilt DB into the APK

**The problem, precisely.** On Android, `bundle.resources` are copied into the APK's `assets/`, and
Tauri's `PathPlugin.kt` `getResourcesDir()` returns the literal string `"asset://localhost/"`. That
is not a filesystem path. `std::fs::File::open("asset://localhost/resources/usdacore.db")` **returns**
`Err(io::Error { code: 2, kind: NotFound })` (it only panics if you `.unwrap()`), and SQLite cannot
open it at all. On macOS the same call resolves to `…/trackit.app/Contents/Resources/…`, a real
path. Copy-out on first run is therefore mandatory on Android and free on macOS.

**The one cross-platform primitive** is `tauri_plugin_fs::FsExt::open`, whose desktop and Android
implementations share a signature and both return a real `std::fs::File`: on desktop it falls
through to `std::fs`; on Android it detects the `asset://localhost/` prefix and obtains an fd via
the Kotlin `FsPlugin.getFileDescriptor`. Do **not** use `app.fs().read()` — it returns `Vec<u8>`
(whole file in RAM; crashes reported ≥ 90 MB).

```rust
// src-tauri/src/seed.rs
use sha2::{Digest, Sha256};
use tauri::{Manager, path::BaseDirectory};
use tauri_plugin_fs::{FsExt, OpenOptions};

const EXPECTED_SHA256: &str = env!("USDA_CORE_SHA256");   // baked by build.rs
const DATASET_VERSION: &str = env!("USDA_CORE_VERSION");

pub fn ensure_reference_db(app: &tauri::AppHandle) -> Result<std::path::PathBuf, SeedError> {
    let dir = app.path().app_data_dir()?.join("reference");
    std::fs::create_dir_all(&dir)?;
    let final_path = dir.join("usdacore.db");
    let stamp_path = dir.join("usdacore.stamp");

    // Update detection is one comparison. No version table, no migration, no ambiguity.
    if final_path.exists() {
        if let Ok(stamp) = std::fs::read_to_string(&stamp_path) {
            if stamp.trim() == EXPECTED_SHA256 { return Ok(final_path); }
        }
    }

    let src = app.path().resolve("resources/usdacore.db", BaseDirectory::Resource)?;

    // TRAP: OpenOptions::read returns &mut Self while Fs::open takes OpenOptions BY VALUE.
    // `OpenOptions::new().read(true)` is &mut OpenOptions -> E0308. Bind it first.
    let mut opts = OpenOptions::new();
    opts.read(true);
    let mut reader = app.fs().open(src, opts)?;          // identical call on macOS and Android

    let partial = dir.join("usdacore.db.partial");
    let mut writer = std::fs::File::create(&partial)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
        std::io::Write::write_all(&mut writer, &buf[..n])?;
    }
    writer.sync_all()?;                                   // fsync BEFORE rename
    let actual = hex::encode(hasher.finalize());
    if actual != EXPECTED_SHA256 {
        let _ = std::fs::remove_file(&partial);
        return Err(SeedError::Integrity { expected: EXPECTED_SHA256.into(), actual });
    }
    std::fs::rename(&partial, &final_path)?;              // atomic swap
    fsync_dir(&dir)?;                                     // durability of the rename itself
    std::fs::write(&stamp_path, EXPECTED_SHA256)?;
    purge_android_asset_cache(app);                       // see below
    Ok(final_path)
}
```

`build.rs`:

```rust
fn main() {
    println!("cargo:rerun-if-changed=resources/usdacore.db");
    let bytes = std::fs::read("resources/usdacore.db")
        .expect("run `cargo run -p usda-ingest` first — resources/usdacore.db is gitignored");
    let digest = hex::encode(sha2::Sha256::digest(&bytes));
    let lock: serde_json::Value =
        serde_json::from_slice(&std::fs::read("resources/usdacore.lock.json").unwrap()).unwrap();
    println!("cargo:rustc-env=USDA_CORE_SHA256={digest}");
    println!("cargo:rustc-env=USDA_CORE_VERSION={}", lock["dataset_version"].as_str().unwrap());
    tauri_build::build();
}
```

`usdacore.lock.json` is committed (`{dataset_version, sha256, food_rows, nutrient_rows, built_at}`);
`usdacore.db` is gitignored. A `cargo test` in `usda-ingest` asserts the freshly built file's hash
equals the lockfile's, so a rebuild from different inputs is caught rather than silently shipped.

**Integrity check on open** — cheap first, expensive only on failure:

```rust
let conn = Connection::open_with_flags(
    &path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;  // no CREATE bit
let v: String = conn.query_row("SELECT value FROM meta WHERE key='dataset_version'", [], |r| r.get(0))
    .map_err(|_| { /* only now: PRAGMA integrity_check, then re-extract once */ })?;
```

Omitting `SQLITE_OPEN_CREATE` is what turns a failed extraction into a loud error rather than an
empty database — precisely the failure mode `tauri-plugin-sql` would hand us.

**Six Android-specific rules, each of which has a silent-failure mode behind it:**

1. **Keep the `.db` extension and do NOT add `androidResources { noCompress += "db" }`.** `.db` is
   not in aapt2's default no-compress list, which routes `tauri-plugin-fs` onto its
   decompress-to-cache path. Making the asset uncompressed sends it down the `openFd` path, which
   discards `AssetFileDescriptor.getStartOffset()` and would hand back **the APK from byte 0**.
   This is the opposite of the usual Android advice and it is deliberate. (It also means zstd
   pre-compression is pointless — the APK entry is already deflated.)
2. **Avoid underscores in the bundled filename** (`usdacore.db`, not `usda_core.db`). One
   unreplicated report (tauri#14853) of the Android bundler mishandling underscores; avoiding them
   costs nothing.
3. **Delete `cacheDir/_assets/` after the rename.** On Android the DB transiently exists three
   times — compressed in the APK, decompressed in `_assets`, and final. `tauri-plugin-fs` never
   cleans up. For a 20 MB DB that is ~60 MB of transient disk on a device that may not have it.
4. **Clean the injected assets directory before every Android build.** `inject_resources()` copies
   `bundle.resources` into `src-tauri/gen/android/app/src/main/assets/` and does **not** clean it
   between builds, so a renamed or removed resource persists into the APK — an update could ship
   both an old and a new DB. Add to the build script:
   `rm -rf src-tauri/gen/android/app/src/main/assets/resources`.
5. **Add `/src/main/assets/resources/` to `src-tauri/gen/android/app/.gitignore`.** Today that file
   excludes only `tauri.conf.json` under `assets/` (six lines, verified on disk), so a 20 MB binary
   would otherwise land in git.
6. **Never use `immutable=1`** on the reference DB. SQLite skips change detection and will serve
   stale or garbage pages, without error, after the file is replaced by rename. Do the swap inside
   `setup()` before any connection is opened.

Both `resources/usdacore.db` and the extraction run identically on macOS, where the only difference
is that `app.fs().open` falls through to `std::fs`. One code path, verified on both platforms in
Phase 3.

`tauri.conf.json` addition:

```json
"bundle": {
  "resources": ["resources/usdacore.db"],
  "android": { "minSdkVersion": 24 }
}
```

---

## 5. Plugins, capabilities, permissions

### 5.1 The (short) plugin list

Every plugin is an ACL surface and a version-lockstep obligation, so the list is deliberately
minimal. Crate and npm versions must match exactly; pin without `^`.

| Purpose | Crate | npm | Notes |
|---|---|---|---|
| Open external URLs (USDA source pages) | `tauri-plugin-opener` **2.5.5** | `@tauri-apps/plugin-opener` **2.5.5** | already installed |
| Open bundled asset (`asset://localhost/…`) | `tauri-plugin-fs` **2.5.2** | *none* | Rust-side only. The webview gets **no** fs permission |
| Logging (logcat on Android, file on desktop) | `tauri-plugin-log` **2.9.1** | *optional* | How you debug §4.3 on device |
| Barcode scanning | `tauri-plugin-barcode-scanner` **2.4.6** | `@tauri-apps/plugin-barcode-scanner` **2.4.6** | **mobile-only**, target-gated |
| CSV export file picker | `tauri-plugin-dialog` **2.7.3** | `@tauri-apps/plugin-dialog` **2.7.3** | Phase 9 only |

Deliberately **not** installed, with reasons:

- `tauri-plugin-sql` — §4.1, and it would make the `links` choice for us.
- `tauri-plugin-http` — the webview never fetches. Its value is a CORS-free `fetch` for JS; we use
  `reqwest` directly in `crates/net` instead: `reqwest = { version = "0.12", default-features = false,
  features = ["json", "gzip", "rustls-tls-webpki-roots", "http2"] }`. `rustls-tls-webpki-roots` avoids
  an OpenSSL-for-Android build entirely and gives a predictable root store across Android versions.
- `tauri-plugin-store` — settings go in `user.db`. The FDC API key must never enter the JS bundle
  or cross IPC; `set_fdc_api_key` is write-only and `app_status` exposes only `has_fdc_key: bool`.
- `tauri-plugin-os` — `app_status` returns the platform from `cfg!`, one fewer ACL surface.
- `tauri-plugin-notification`, `-shell`, `-updater`, `-window-state` — not needed by v1; the last
  two are desktop-only anyway.

Network etiquette encoded in `crates/net`: a `User-Agent` of
`TrackIt/<version> (kgundu1@asu.edu)` (Open Food Facts requires a custom UA), a client-side
limiter at 15 req/min for OFF product reads and 10 req/min for OFF search, gzip on, and the user's
own registered `api.data.gov` key (DEMO_KEY is shared and rate-limited to 10 req/hour; a registered
key gets 1,000/hour). OFF v2 returns a proper 404 for an unknown barcode, so `NotFound` is a real
signal, not an inference.

### 5.2 Capabilities

```json
// src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Core IPC for the main window. The webview is granted NO filesystem, NO SQL, NO HTTP.",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:allow-open-url",
    "log:default"
  ]
}
```

```json
// src-tauri/capabilities/mobile.json
{
  "$schema": "../gen/schemas/mobile-schema.json",
  "identifier": "mobile",
  "description": "Barcode scanning. Android/iOS only.",
  "platforms": ["android", "iOS"],
  "windows": ["main"],
  "permissions": [
    "barcode-scanner:allow-scan",
    "barcode-scanner:allow-cancel",
    "barcode-scanner:allow-check-permissions",
    "barcode-scanner:allow-request-permissions"
  ]
}
```

That is the entire ACL surface: opening a URL, logging, and scanning. Everything else goes through
our own `#[tauri::command]`s, which the ACL does not gate individually and which cannot be reached
with arbitrary SQL.

**Open point to verify in Phase 3.** Rust-side `app.fs().open()` reaches Kotlin via
`PluginHandle::run_mobile_plugin`, which should bypass the webview ACL entirely. If Android
extraction fails with a permission error, add a *scoped* fs permission rather than `fs:default`:

```json
{ "identifier": "fs:allow-open", "allow": [{ "path": "$RESOURCE/resources/usdacore.db" }] }
```

Do **not** grant `fs:default` — it would hand the webview a general filesystem API for the sake of
one Rust-side call.

### 5.3 Android manifest

The generated manifest (verified on disk) already has `INTERNET`, the leanback feature, the
`singleTask` launcher activity and the `FileProvider`. Three edits, all in
`src-tauri/gen/android/app/src/main/AndroidManifest.xml`, all committed:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
          xmlns:tools="http://schemas.android.com/tools">

    <uses-permission android:name="android.permission.INTERNET" />

    <!-- The barcode-scanner AAR declares CAMERA as REQUIRED, which silently makes a camera
         mandatory for installation. Relax it; the app is fully usable without one. -->
    <uses-feature android:name="android.hardware.camera"     android:required="false"
                  tools:replace="android:required" />
    <uses-feature android:name="android.hardware.camera.any" android:required="false"
                  tools:replace="android:required" />

    <application
        android:fullBackupContent="@xml/backup_rules"
        android:dataExtractionRules="@xml/data_extraction_rules"
        …>
```

`android.permission.CAMERA` is merged in from the plugin's AAR — do not add it manually.

### 5.4 Committing `gen/android`

Commit `src-tauri/gen/android/` in full. `tauri android init` preserves existing files, so hand
edits survive re-running it — but they do **not** survive a fresh clone or an `rm -rf`, and neither
`gen/android/.gitignore` nor `app/.gitignore` excludes `AndroidManifest.xml` or `MainActivity.kt`.
Add one line to `app/.gitignore` (see §4.3 rule 5):

```
/src/main/assets/resources/
```

Caveat: committing `gen/android` also versions the package-manager name (`pnpm`) baked into
`buildSrc/src/main/kotlin/BuildTask.kt`. A contributor using npm would need to re-run
`tauri android init`. Acceptable for a single-developer project.

### 5.5 Barcode scanner: two live bugs and one silent state

Target-gated in `Cargo.toml` (§2) and in `lib.rs`:

```rust
let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_log::Builder::new().build());
#[cfg(mobile)]
{ builder = builder.plugin(tauri_plugin_barcode_scanner::init()); }
```

The frontend never sniffs `navigator.userAgent`; it reads `app_status.barcode_available`, which is
`cfg!(mobile)`.

| Failure | Mechanism | Mitigation (mandatory) |
|---|---|---|
| **QR bleed-through / all formats enabled** | `BarcodeScannerPlugin.kt`'s `mapFormats()` is `if (integers[i] != FORMAT_QR_CODE) ret[i] = integers[i]` over a zero-initialised `IntArray`, and ML Kit's `Barcode.FORMAT_ALL_FORMATS == 0`. Including `Format.QRCode` in the request therefore leaves a `0` and silently enables **every** format (tauri#3337 understates this) | Never trust `result.format`. Validate the payload is 8/12/13/14 digits **and** the GTIN mod-10 check digit passes, in Rust, before any network lookup or UI commit. `Gtin` is a newtype with a private constructor |
| **Promise never settles** | `cancel()` can leave the `scan()` promise unresolved (tauri#3560); `scan()` sometimes never returns (tauri#2238) | Never `await scan()` bare. `Promise.race([scan(), timeoutAfter(25_000), cancelSignal])`, driven by a state machine that can always return to `idle` |
| **Silent no-results on a fresh install** | The plugin uses ML Kit's **unbundled** (Play-services) variant; the model downloads on first use and returns nothing until it does | Treat "first scan needs a one-time setup download" as a first-class UI state. Offline first-run must say so, not show a camera that never fires. Test on `Pixel_9_Pro_XL` (android-36, **google_apis_playstore**), not on a `google_apis`-only image |

Scan flow: `scan({ windowed: true, formats: [EAN13, EAN8, UPC_A, UPC_E] })` with an
`html[data-scanning]` rule making the page transparent so the camera preview shows through.
**A scan is never auto-logged** — it lands on a confirmation sheet showing the resolved food, its
source (USDA / Open Food Facts / cache), and its nutrient coverage, because a mis-scan is a silent
wrong nutrition number.

Desktop: manual GTIN entry through the same `lookup_barcode` command and the same confirmation
sheet, with mod-10 validation. No webcam path in v1 (WKWebView `getUserMedia` inside Tauri is
unverified, and `BarcodeDetector` does not exist in WKWebView).

---

## 6. Frontend

### 6.1 Toolchain — keep what is proven

The scaffold already builds and runs on both targets. Do **not** chase Vite 8 / plugin-react 6 /
TypeScript 7: `@vitejs/plugin-react 6.x` hard-requires `vite ^8`, and the host's working set is
`vite 7.3.6 + @vitejs/plugin-react 4.7.0 + react 19.2.8 + typescript 5.8.3` on Node 26.3.0.

Additions:

```bash
cd /Users/kgundu1/BioBalance
pnpm add @tanstack/react-query@5.102.8 zustand@5.0.15 wouter@3.10.0
pnpm add @tauri-apps/plugin-barcode-scanner@2.4.6
```

`tsconfig.json` is already `"strict": true`; add `"noUncheckedIndexedAccess": true` and
`"exactOptionalPropertyTypes": true`.

**Pin the build target explicitly** in `vite.config.ts` — do not copy the official template's
`TAURI_ENV_PLATFORM` ternary, whose `safari13` fallback would apply to Android on a mis-detect and
ship unparseable syntax as a white screen:

```ts
build: { target: ['chrome111', 'safari16.4'], minify: !process.env.TAURI_ENV_DEBUG, sourcemap: !!process.env.TAURI_ENV_DEBUG }
```

### 6.2 State

**TanStack Query is the only server-state layer.** `queryFn` wraps `invoke` directly; query keys
mirror command names and arguments.

**No optimistic updates for logging.** Not for performance reasons (a SQLite round-trip is 1–3 ms)
but for correctness: an optimistic total means JavaScript adding nutrient numbers, which is exactly
the thing §1.1 forbids. Instead, `log_entry` **returns the fresh `DayDashboard`**, and the mutation's
`onSuccess` does `queryClient.setQueryData(['day', profileId, day], response)`. The UI updates in
one frame, and every number in it was computed in Rust.

**Zustand** holds ephemeral UI only: selected date, scanner sheet state, expanded nutrient sections,
search draft. Nothing derived from a nutrient value ever lives in a store.

### 6.3 Routing and window/webview config

Plain **history routing** with `wouter` 3.10.0. History-backed routing is mandatory because wry
registers an `OnBackPressedCallback` that calls `webView.goBack()` — the Android back gesture drives
WebView session history, so in-memory routing would exit the app instead of navigating back. Hash
routing is *not* required: Tauri's embedded-asset protocol resolves an asset through exact path →
`{path}.html` → `{path}/index.html` → `index.html`, logging `Asset '{path}' not found; fallback to
index.html` — a real SPA fallback, present in released tags.

`tauri.conf.json` (deltas from the scaffolded file):

```json
{
  "app": {
    "windows": [{
      "title": "TrackIt",
      "width": 1100, "height": 760, "minWidth": 360, "minHeight": 480,
      "useHttpsScheme": true
    }],
    "withGlobalTauri": false,
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'"
    }
  }
}
```

`useHttpsScheme: true` **before the first release build**: it makes the Android origin
`https://tauri.localhost`, an unambiguous secure context, and Tauri's own docs warn that changing it
later relocates IndexedDB/localStorage/cookies and orphans existing data. (The `tauri://localhost`
origin on macOS is already potentially-trustworthy — WebKit's check passes on both the localhost
host and the registered scheme handler — so `crypto.subtle` and friends are fine either way; the
reason to set it is the one-way-door, not a capability gap.)

No remote images in v1: OFF product photos would force `img-src https://images.openfoodfacts.org`
into the CSP and add a network dependency to the food list. Text only.

### 6.4 Charts

**No charting library.** Because Rust already emits normalised percentages and formatted tick
labels (D5), every visual in v1 is a short hand-written SVG:

- **Daily dashboard**: 50 interval bars. These are CSS grid + two absolutely-positioned divs and an
  SVG `<pattern>` for the hatch. No library could draw this mark anyway.
- **Trends**: one `<svg viewBox="0 0 100 100" preserveAspectRatio="none">` containing a `<path>`
  for the lower-bound line and a `<path>` for the [lower, upper] band, both built by string-joining
  Rust-supplied `{x_pct, y_pct}` pairs. Add `vector-effect="non-scaling-stroke"` so
  `preserveAspectRatio="none"` does not distort stroke width. Axis labels live in a sibling,
  non-scaled layer positioned with `%`.
- **Interaction**: a tap-and-drag **scrubber** with a fixed readout *above* the chart — not a
  floating tooltip. On a 390 px screen a floating tooltip sits under the finger, and Recharts'
  touch-tooltip dismissal issue (#2100) is still open five years on.

Cost comparison for the record: Recharts 3.10.1 measures 144 KB gzip and pulls `@reduxjs/toolkit`,
`immer` and `victory-vendor`; visx 4.0.0 primitives measure 48.4 KB gzip naively summed and roughly
25–30 KB after `@visx/vendor` dedupe. **visx 4.0.0 remains the named escape hatch**, lazy-loaded via
`React.lazy`, if a later screen genuinely needs interactive scales, brushing or zoom. Nothing in v1
does.

### 6.5 Android edge-to-edge, safe areas, and the keyboard

Tauri's Android template calls `enableEdgeToEdge()` in `MainActivity.onCreate` (verified on disk),
and with `targetSdk = 36` the `windowOptOutEdgeToEdgeEnforcement` opt-out is ignored — so the
WebView draws under the status bar and the gesture pill, unconditionally.

Android WebView **does** forward system-bar insets to CSS `safe-area-inset-*`: `displayCutout()` and
`systemBars()` since M136 for fullscreen WebViews and since M144 for **all** WebViews, with M139
adding `ime()` via visual-viewport resizing. Stable WebView is 152/153. So `env(safe-area-inset-*)`
is the primary mechanism, not a broken one — but `minSdk = 24` devices can carry an older WebView,
so belt-and-braces:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```
```css
:root {
  --inset-top:    max(env(safe-area-inset-top,    0px), var(--fallback-inset-top,    0px));
  --inset-bottom: max(env(safe-area-inset-bottom, 0px), var(--fallback-inset-bottom, 0px));
  --inset-left:   max(env(safe-area-inset-left,   0px), var(--fallback-inset-left,   0px));
  --inset-right:  max(env(safe-area-inset-right,  0px), var(--fallback-inset-right,  0px));
  --keyboard-inset-bottom: 0px;
}
.app-header { padding-top: calc(var(--inset-top) + 8px); }
.app-tabbar { padding-bottom: calc(var(--inset-bottom) + 8px); }
.sheet      { padding-bottom: max(var(--inset-bottom), var(--keyboard-inset-bottom)); }
```

`max()` means the two sources can never double-count. The fallback variables are published by a
`MainActivity` override, which is now a *compatibility shim* rather than the load-bearing fix:

```kotlin
// src-tauri/gen/android/app/src/main/java/com/kgundu1/trackit/MainActivity.kt  (COMMITTED)
package com.kgundu1.trackit

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
      val d  = v.resources.displayMetrics.density
      val sb = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                                or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val js = """
        (function(){var s=document.documentElement.style;
          s.setProperty('--fallback-inset-top',    '${sb.top    / d}px');
          s.setProperty('--fallback-inset-bottom', '${sb.bottom / d}px');
          s.setProperty('--fallback-inset-left',   '${sb.left   / d}px');
          s.setProperty('--fallback-inset-right',  '${sb.right  / d}px');
          s.setProperty('--keyboard-inset-bottom', '${ime.bottom/ d}px');})();
      """.trimIndent()
      webView.evaluateJavascript(js, null)
      insets
    }
  }
}
```

On modern WebViews the same listener still supplies `--keyboard-inset-bottom`, which is what fixes
the long-standing keyboard-covers-the-input bug (tauri#7868) on WebViews below M139. On M139+ the
`visualViewport` API agrees, and `max()` keeps them consistent.

**Startup version gate.** `app_status.webview_version` comes from `tauri::webview_version()`. Below
Chromium 111 the app renders a plain HTML "update Android System WebView" screen instead of the
app — modern CSS degrades to *visually broken*, not to a loud failure, and a silently misrendered
nutrition dashboard is worse than a blocked one. Verify primarily on the android-36
`google_apis_playstore` AVD (updatable WebView) and treat `Pixel_3a_API_33` (frozen WebView) as the
deliberate old-WebView test.

### 6.6 Input rules

| Rule | Why |
|---|---|
| `<input type="text" inputMode="decimal">`, never `type="number"` | Comma-decimal locales can yield an empty `value` from `type=number`; the raw string goes to Rust and is parsed there |
| Unparseable quantity **blocks** the Add button | Defaulting to `1` is a silent wrong number |
| Never `new Date(str)` to derive a day; never `toISOString().slice(0,10)` | A food-log day is a local-calendar concept. `toISOString` returns *tomorrow* for western timezones after ~17:00. Rust owns `today_local()` |
| Search results: local FTS renders immediately in **frozen** order; online results append below a labelled divider | A list that reflows under a finger causes mis-taps, and a mis-tap logs the wrong food |

---

## 7. The hard UI problem: ~50 nutrients, three-state values, coverage, 390 px → desktop

### 7.1 The atom — the interval bar

Every nutrient, everywhere, is the same component. It renders `BarGeometry` (§1.5) and nothing else.

```
Selenium                                              ≥34 µg
├──────────── solid ────────────┤////hatch////┤       ⟩        ● RDA        ▲ UL
0                                                      2 of 5 foods measured
```

Four visual channels, each carrying one fact:

| Channel | Encodes | Rendering |
|---|---|---|
| **Solid segment** | `lower` — "at least this much" | filled, `width: var(--lower-pct)` |
| **Hatched segment** | `upper − lower` — bounded uncertainty (below-LOQ, label-rounded zeros) | 45° SVG `<pattern>`, same hue at 35 % alpha |
| **Open right edge** | `UpperBound::Unbounded` — at least one food has no row at all | the bar's right border fades out into a `⟩` chevron; its width is `unmeasured_mass_pct`, i.e. **mass coverage**, and is labelled as such. Never a hatch, because there is no ceiling to hatch to |
| **Track ticks** | RDA/AI at a **constant x across all nutrients**, UL further right | `0 → target` occupies the first 60 % of the track, `target → UL` the remaining 40 %. Non-linear but labelled, so the eye can scan a whole column for "past the tick" |

Where no UL exists (thiamin, riboflavin, B12, pantothenate, biotin, potassium, vitamin K), the track
beyond the target tick is neutral grey and the row reads "no UL established" on expand — never
"unlimited", never an empty red zone.

Colour is never the only channel. A leading glyph carries the verdict: `▲` certainly over UL,
`●` target met, `◐` indeterminate, `○` certainly short, `—` no data.

### 7.2 The text — one component, five rules

`<NutrientAmount>` is the **only** place in the codebase where a nutrient becomes a DOM string, and
it consumes `geometry.label`, which Rust already formatted:

| State | Label |
|---|---|
| coverage complete, `lower == upper` | `34 µg` |
| coverage complete, bounded uncertainty | `34–41 µg` |
| some item `Absent` | `≥34 µg` |
| nothing measured, some bounded | `≤7 µg` |
| everything `Absent` | `—` |

Its `switch (v.kind)` ends in `default: assertNever(v)`, so adding a variant in Rust breaks the
build rather than rendering blank.

### 7.3 The day screen — four zones, in this order

1. **Energy + macro strip** — 4 tiles (kcal, protein, carbs, fat), always visible, never missing.
   Energy resolves through the documented `1008 → 2047 → 2048` chain in Rust and the tile shows
   which id was used on tap; the three ids disagree by up to 23 % on the same food and are never
   averaged.
2. **Needs attention** — at most 6 rows, ranked by a Rust-computed `severity`: certainly-over-UL
   first, then certainly-short-of-RDA, then may-be-over-UL. If empty, the section is absent
   entirely (not an empty state).
3. **All nutrients** — 5 collapsible sections in a fixed order: *fat-soluble vitamins*,
   *water-soluble vitamins*, *major minerals*, *trace minerals*, *other* (fiber, sodium, cholesterol,
   added sugars, choline). Each header carries a coverage chip: `13 of 14 tracked · 3 no data`.
   Default: collapsed, except any section containing an attention item.
4. **No data in any bundled source** — always last, always collapsed, a plain list with no bars.
   This is the honest home for iodine, chromium, molybdenum, biotin and added sugars whenever
   everything logged came from SR Legacy (which has literally zero rows for all five). They appear
   **once**, as names with a reason — never as fifty 0 % bars, which is the exact rendering this
   entire architecture exists to prevent.

Row height: 44 px normally (touch target), 56 px when a coverage caption is shown — which is a
minority of rows, so the list does not feel uniformly heavy. Fifty rows is ~2,300 px of scroll,
which zones 2–4 make navigable without virtualisation.

### 7.4 One shell, three layouts

The breakpoint is a **container query** on the nutrient list, not a viewport media query, so the same
component is correct in a phone list and in a desktop side panel.

| Mode | Width | Chrome | Nutrient list |
|---|---|---|---|
| `compact` | < 640 px | bottom tab bar (`Log · Today · Search · More`) | 1 column, sections collapsible |
| `regular` | 640–1023 px | bottom tab bar | `grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`; section headers `grid-column: 1 / -1` |
| `expanded` | ≥ 1024 px | left nav rail | 3-pane: rail · day log · nutrient panel; all sections expanded; extra "vs. 7-day median" column |

**The only structural swap is `<AppChrome>`** (bottom tabs ↔ left rail) and the grid column count.
Everything below `<AppChrome>` — every row, every bar, every label — is one implementation. Two
shells would mean two implementations of the missing-vs-zero rendering rule, and one of them would
eventually be wrong.

Desktop additionally offers a **table view** toggle over the identical DTO: columns for nutrient,
lower, upper, coverage, %RDA, %UL, verdict — reusing `<NutrientAmount>` for the value cell. It is a
different presentation of the same data, not a different data path.

### 7.5 Accessibility

Each row is `role="listitem"` with `aria-label = geometry.a11y_label`, composed in Rust from the
same rules: *"selenium, at least 34 micrograms, 2 of 5 foods measured, target 55 micrograms not
confirmed met."* Screen readers get the uncertainty, not just the number. The hatch pattern and the
verdict glyph make every state distinguishable without colour.

---

## 8. Phased implementation plan

Already proven on this host — do not re-litigate or re-sequence around it:
Android debug APK builds for aarch64, installs on the API-36 arm64 emulator, renders, and a Rust
`greet` command round-trips over IPC. macOS `.app` and `.dmg` build. The toolchain is complete.

Still unproven, in risk order:
**(A)** `rusqlite` with `bundled` (which compiles SQLite from C) linking under NDK 29 for
`aarch64-linux-android`; **(B)** the bundled-DB-into-APK extraction path; **(C)** camera + ML Kit
model download; **(D)** the release APK launching with R8 minification on (`isMinifyEnabled = true`
in the generated release build type, and tauri#15337 has a history of R8 launch crashes).

The plan therefore proves A, B and D on a skeleton before any feature work sits on top of them.

---

### Phase 0 — Workspace split and the typed IPC skeleton (no database)

**Goal.** The type system that makes the bug unrepresentable, running end to end, before there is
any data to get wrong.

**Files.** Root `Cargo.toml` (new workspace); `crates/core/{Cargo.toml,src/{lib,units,value,verdict,
format,geometry,error}.rs}`; `src-tauri/Cargo.toml` (workspace member, add `trackit-core`);
`src-tauri/src/{lib.rs,state.rs,error.rs,commands/{mod,status}.rs}`; `src/bindings/` (generated);
`src/ipc/index.ts`; `src/__typetests__/no-silent-zero.ts`; `.eslintrc` restricted-syntax rules;
`scripts/ci-grep-gate.sh`.

**Verify.**
```bash
cargo tree -p trackit-core | grep -c '^tauri'          # 0
cargo test -p trackit-core                              # unit + proptest green, no webview built
cargo test -p trackit-core export_bindings && git diff --exit-code src/bindings/
pnpm exec tsc --noEmit                                     # the @ts-expect-error file must pass
pnpm tauri dev                                             # app_status renders version + platform
```
Then deliberately break it: delete one `@ts-expect-error` in `no-silent-zero.ts` and confirm `tsc`
fails. That negative test is the phase's real deliverable.

---

### Phase 1 — rusqlite on both targets, `user.db` live

**Goal.** Prove risk (A) with the smallest possible surface, and get a real user database.

**Files.** `crates/core/src/db/{mod,user,migrations}.rs`; `migrations/001_init.sql` (from
`docs/architecture-data.md`); `src-tauri/src/commands/profile.rs`.

**Verify.**
```bash
cargo tree -i libsqlite3-sys                     # exactly ONE version — proves the links choice held
pnpm tauri dev                                   # save + reload a profile
sqlite3 "$HOME/Library/Application Support/com.kgundu1.trackit/user.db" \
  'PRAGMA journal_mode; PRAGMA foreign_keys; PRAGMA user_version;'   # wal | 1 | 1
pnpm tauri android dev                           # same round-trip on the emulator
adb shell run-as com.kgundu1.trackit ls -la files/
```
WAL must be asserted, not assumed — nothing sets it for you.

---

### Phase 2 — `usda-ingest` builds `usdacore.db`

**Goal.** A real reference database from `data/raw/extracted/`, built with the *same* `crates/core`
unit and value semantics the app reads it with.

**Files.** `crates/usda-ingest/src/main.rs`; `scripts/schema_reference.sql`;
`src-tauri/resources/usdacore.lock.json` (committed); `.gitignore` += `src-tauri/resources/*.db`.

Ingest rules that belong to this phase (details in `docs/architecture-data.md`): the
`1008 → 2047 → 2048` energy chain with the resolved id recorded; the fiber (1079/2033),
carbohydrate (1005/1050), sugars (2000/1063) and ALA (1270/1404) forks; the iodine join on the ARS
sheet's **column B** (`FDC NDB No.`), never column A `DB_ID`; `value_kind` derived from
`derivation_id` (`Z` = assumed zero, `A` = analytical) since **no bulk download has an LOQ column**.

**Verify.**
```bash
cargo run -p usda-ingest --release
sqlite3 src-tauri/resources/usdacore.db "SELECT count(*) FROM ref_foods;"          # ≈ 13,600
sqlite3 src-tauri/resources/usdacore.db \
  "SELECT value_kind, count(*), sum(amount IS NULL) FROM ref_food_nutrients GROUP BY 1;"
# 'absent' must be the ONLY kind with NULL amounts, and its NULL count must equal its row count
sqlite3 src-tauri/resources/usdacore.db \
  "SELECT count(*) FROM ref_food_nutrients rn JOIN nutrients n USING(nutrient_id)
   WHERE n.name='Iodine, I';"                                                     # ≥ 369
sqlite3 src-tauri/resources/usdacore.db \
  "SELECT * FROM ref_foods_fts WHERE ref_foods_fts MATCH 'salmon' LIMIT 5;"
sqlite3 src-tauri/resources/usdacore.db "VACUUM; ANALYZE;" && du -h src-tauri/resources/usdacore.db
cargo test -p usda-ingest                        # built hash == usdacore.lock.json
```

---

### Phase 3 — **Bundled DB into the APK, and out again** (the risky one)

**Goal.** Prove risk (B) on both platforms with nothing else in flight.

**Files.** `src-tauri/build.rs`; `src-tauri/src/seed.rs`; `tauri.conf.json` (`bundle.resources`,
`bundle.android.minSdkVersion`); `gen/android/app/.gitignore` (+`/src/main/assets/resources/`);
`gen/android/app/src/main/res/xml/{backup_rules,data_extraction_rules}.xml`; `AndroidManifest.xml`
(backup attrs); `package.json` script `"android:clean-assets": "rm -rf src-tauri/gen/android/app/src/main/assets/resources"`.

**Verify — macOS.**
```bash
pnpm tauri build --bundles app
ls -la "target/release/bundle/macos/TrackIt.app/Contents/Resources/resources/usdacore.db"
open target/release/bundle/macos/TrackIt.app
shasum -a 256 "$HOME/Library/Application Support/com.kgundu1.trackit/reference/usdacore.db"
cat "$HOME/Library/Application Support/com.kgundu1.trackit/reference/usdacore.stamp"  # same hash
```
**Verify — Android.**
```bash
pnpm android:clean-assets
pnpm tauri android build --apk --debug --target aarch64
unzip -l src-tauri/gen/android/app/build/outputs/apk/**/app-*-debug.apk | grep usdacore
adb uninstall com.kgundu1.trackit
adb install -r src-tauri/gen/android/app/build/outputs/apk/**/app-*-debug.apk
adb logcat -c && adb shell am start -n com.kgundu1.trackit/.MainActivity
adb logcat | grep -i trackit                                   # extraction start/finish, hash OK
adb shell run-as com.kgundu1.trackit ls -la files/reference/    # usdacore.db + .stamp, no .partial
adb shell run-as com.kgundu1.trackit ls    cache/_assets/       # must be EMPTY after purge
```
**Three deliberate failure tests, all of which must be loud:**
1. `adb shell run-as … rm files/reference/usdacore.stamp` → relaunch re-extracts.
2. `adb shell run-as … sh -c 'echo x >> files/reference/usdacore.db'` and clear the stamp → the
   integrity check fails and the app reports `ReferenceCorrupt`, not an empty food list.
3. Ship a `usdacore.db` with a bumped `dataset_version`, install over the top → new data present,
   `user.db` rows intact.

Also confirm here whether `app.fs().open()` needs an fs capability on Android (§5.2). If it does,
add the scoped permission and re-run all of the above.

---

### Phase 4 — Search and food detail (read-only, both platforms)

**Goal.** Everything a user can *look at*, with the three-state rendering working, before anything
is writable.

**Files.** `crates/core/src/db/{reference,search}.rs`; `src-tauri/src/commands/foods.rs`;
`src/screens/{Search,FoodDetail}.tsx`; `src/nutrition/{NutrientAmount,IntervalBar,CoverageChip}.tsx`.

**Verify.** Search "cod, atlantic"; open the detail; assert with a screenshot at 390 px that a
nutrient with no row renders `—` and a "no data in bundled sources" caption. Then, the load-bearing
test: pick an SR Legacy food and confirm **iodine, chromium, molybdenum and biotin all render as
"no data"**, never `0`. Confirm iodized salt (NDB 02047) shows a real measured iodine value.

---

### Phase 5 — Logging and the day dashboard

**Goal.** The centrepiece: intervals, coverage, and the four-zone screen.

**Files.** `crates/core/src/{rollup,portion,geometry}.rs`; `crates/core/src/db/user.rs` (entries +
`nutrient_snapshot`); `src-tauri/src/commands/{log,dashboard}.rs`; `src/screens/Day.tsx`;
`src/shell/AppChrome.tsx`.

**Verify.** Log 5 foods where 3 have no selenium row. The selenium row must read `≥34 µg` with a
`2 of 5 foods measured` caption and an **open right edge**, and its %RDA must be indeterminate — not
"deficient". Delete one of the two measured foods; the lower bound drops and coverage updates.
Screenshot at 390 px, 800 px and 1280 px from the *same* build. Run `scripts/ci-grep-gate.sh` and
confirm zero hits for `total(`, `coalesce(sum`, `?? 0`.

---

### Phase 6 — Targets, DRIs and verdicts

**Files.** `crates/core/src/targets.rs`; `migrations/002_targets.sql`;
`src-tauri/src/commands/targets.rs`; `src/screens/Profile.tsx`.

**Verify.** Three regression tests that encode the corrections in `data-findings.md`:
1. Log 2 kg of carrots → **no** vitamin A UL warning (the UL is preformed retinol, id 1105, not RAE).
2. Chromium and biotin rows are labelled **AI**, never RDA.
3. Thiamin's UL row reads "no UL established", and the track beyond the target is neutral, not red.
Plus: a profile whose birthdate crosses a DRI life-stage boundary changes targets on the correct day
(age is derived, never stored).

---

### Phase 7 — Custom foods and recipes

**Files.** `crates/core/src/recipe.rs`; `migrations/003_recipes.sql`;
`src-tauri/src/commands/recipes.rs`; `src/screens/{CustomFood,Recipe}.tsx`.

**Verify.** A 3-level nested recipe's per-serving interval matches a hand calculation. Depth 6 is
rejected with `RecipeTooDeep`. A cycle is rejected with `RecipeCycle`. An ingredient with an absent
nutrient propagates `Unbounded` to the recipe's upper bound — it does not quietly vanish.
Soft-deleting a custom food referenced by a historical entry leaves that entry's snapshot intact.

---

### Phase 8 — Online lookup and barcode

**Files.** `crates/net/src/lib.rs`; `crates/core/src/db/cache.rs`;
`src-tauri/src/commands/online.rs`; `src/screens/ScanSheet.tsx`; `capabilities/mobile.json`;
`AndroidManifest.xml` camera-optional edits; `Cargo.toml` target-gated dependency.

**Verify.** On `Pixel_9_Pro_XL`: scan an EAN-13 → confirmation sheet with source provenance, not an
auto-log. Present a **QR code** → rejected before any network call (GTIN validation, §5.5). Open the
scanner and immediately cancel → the promise settles and the UI returns to idle within the timeout.
Airplane mode on a fresh install → "barcode scanning needs a one-time setup download", not a dead
camera. On macOS: `barcode_available === false`, manual GTIN entry present, an invalid check digit
is rejected. Confirm an OFF product with 19 absent micronutrients renders 19 "no data" rows, not 19
zeros — this is the whole reason the union exists.

---

### Phase 9 — Trends

**Files.** `crates/core/src/geometry.rs` (`TrendGeometry`); `src-tauri/src/commands/trends.rs`;
`src/screens/Trends.tsx`.

**Verify.** A 365-day selenium trend renders with a visible coverage band; the scrubber tracks a
finger drag on the emulator; days with no data are **gaps in the line**, not zeros (a line that dips
to zero on an unlogged day is the same lie in a different shape). Payload under 64 KB.

---

### Phase 10 — Release hardening

**Files.** `gen/android/app/build.gradle.kts` (R8 settings if needed);
`gen/android/keystore.properties` (gitignored); `.github/` or `scripts/release.sh`.

**Verify.**
```bash
pnpm android:clean-assets && pnpm tauri android build --apk --target aarch64
adb install -r <release apk> && adb shell am start -n com.kgundu1.trackit/.MainActivity
```
The release APK must **launch** — R8 is on by default in the generated release build type and has a
history of launch crashes (tauri#15337). If it crashes, first try `cargo update -p tao`, then
`isMinifyEnabled = false` and `android.enableR8.fullMode=false`, in that order.
Desktop: `pnpm tauri build --bundles app` (skip the `.dmg` for personal use — it avoids the vendored
`bundle_dmg.sh` and its osascript Finder-automation prompt). Note the artifact is
`target/release/bundle/macos/TrackIt.app` — capitalised, because `productName` in
`tauri.conf.json` is `"TrackIt"`. Changing `productName` is a bundle-identity change, so do it
once and before any distribution.
Finally, re-run the Phase 3 update test on release builds: bump `dataset_version`, install over the
top, confirm new reference data and intact user data.

---

## 9. Commands, corrected

Commands that appear in the research but do **not** work, with the working form:

| Broken | Working | Why |
|---|---|---|
| `pnpm tauri android dev --host Pixel_9_Pro_XL` | `pnpm tauri android dev` (device name is a **positional**) | `--host` is typed `DevHost` and accepts only `""`, `"<public network address>"`, `"<none>"` or an `IpAddr`; clap consumes the next token as its value and fails to parse |
| `curl … FoodData_Central_foundation_food_csv_2026-04-24.zip` | `…_2026-04-30.zip` | The `-24` filename 404s; already downloaded correctly to `data/raw/` |
| `app.fs().open(src, OpenOptions::new().read(true))` | bind `let mut opts = OpenOptions::new(); opts.read(true);` first | `read()` returns `&mut Self`; `Fs::open` takes `OpenOptions` by value → E0308 |
| `sdkmanager … "ndk;28.2.13676358"` / `NDK_HOME=…/28.2.13676358` | NDK **29.0.14206865** is installed and pinned | Pointing `NDK_HOME` at a non-existent directory fails with `NdkHomeNotADir` — there is no fallback to `$ANDROID_HOME/ndk/<version>` |
| Upgrading `cmdline-tools` | **Do not.** 22.0+ deprecates `sdkmanager` and would break Flutter on this host | |
| `brew uninstall rust` | Not done, not needed | rustup 1.29.1 / rustc 1.98.1 already takes PATH precedence; both toolchains coexist by the user's choice |

Also note `x86_64-linux-android` fails with `cannot locate symbol "__extenddftf2"` when bundled
SQLite is compiled in. We build `aarch64` only, so this does not bite; if an x86_64 ABI is ever
added, a `build.rs` must link `libclang_rt.builtins-x86_64-android.a`.

---

## 10. Standing risk register

| Risk | Signal it is happening | Response |
|---|---|---|
| A nutrient value reaches JS as a bare number | `src/bindings/*.ts` contains `\| null`, or a DTO field named `amount` outside a `kind` variant | CI gate (§1.6 layer 2) fails the build |
| `SUM()` skipping NULLs understates a day's intake | A dashboard total that is plausible but low; coverage caption absent | Grep gate (layer 6); every aggregate carries `count(x)`/`count(*)`/`sum(grams)` |
| `serde_json` writing `null` for NaN/∞ | A division by a zero serving size anywhere | Checked constructor (layer 3) + the no-`null` corpus test (layer 4) |
| Stale bundled DB shipped in the APK | Two `usdacore*.db` entries in `unzip -l`, or a `dataset_version` that does not match the lockfile | `pnpm android:clean-assets` before every Android build |
| R8 breaks the release APK | Debug works, release launches to a blank screen | `cargo update -p tao` → `isMinifyEnabled = false` → `enableR8.fullMode=false` |
| `tauri android init` re-run wipes `MainActivity.kt` | Header slides under the status bar on old WebViews | `gen/android` is committed; `git status` after any init |
| Barcode returns a QR payload | A "food" whose GTIN is not 8/12/13/14 digits | `Gtin` newtype rejects it before any network call |
| DRI transcription error | A verdict that contradicts a published table | 600–1,200 hand-transcribed numbers is the largest untested surface in the app; every value gets a source citation column and a spot-check test per nutrient |
| USDA October/December 2026 refresh | New Foundation release lands | Reference DB is replaced wholesale; log entries carry snapshots, so history does not move. Cadence is *not* reliably April/October — 2025's second release landed in December |

---

## 11. Where this document overrides the research

1. **Two databases, not one.** The "one file only" conclusion was entirely downstream of
   `tauri-plugin-sql`'s unconfigurable 10-connection pool making `ATTACH` unreliable. With rusqlite
   we own the connection. The FK-across-ATTACH limitation is real and independent, and is solved by
   log-time snapshots rather than by merging the files.
2. **Keep `.db` compressed in the APK; do not add `noCompress`.** One track recommended
   `.dbz` + `noCompress += "dbz"`; that routes the read through `openFd`, which discards
   `getStartOffset()` and returns the APK from byte 0. Compressed `.db` is the safe path.
3. **No `tauri-plugin-http`, no `-store`, no `-os`.** All three exist to give the *webview* a
   capability. The webview needs none of them, and each is an ACL surface.
4. **History routing, not hash.** The asset protocol's `index.html` fallback is real and present in
   released tags.
5. **No charting library.** Once Rust emits normalised geometry, the remaining work is ~40 lines of
   SVG, and the required uncertainty mark exists in no library. visx 4.0.0 stays named as a
   lazy-loaded escape hatch.
6. **Safe-area insets are a compatibility shim, not the primary mechanism.** Android WebView
   forwards `systemBars()` to CSS since M144 (all WebViews); the Kotlin listener supplies fallbacks
   under `max()` and remains load-bearing only for the keyboard inset below M139.
7. **Stay on Vite 7.3.6 / plugin-react 4.7.0 / TypeScript 5.8.3 / Node 26.3.0.** The scaffold builds
   and runs on both targets today; plugin-react 6 would force a Vite 8 upgrade for no feature this
   app needs.

## 12. Open questions

1. **Does `app.fs().open()` on Android require an `fs` capability grant?** Rust→Kotlin via
   `PluginHandle::run_mobile_plugin` should bypass the webview ACL, but this is unverified.
   Resolved empirically in Phase 3; the scoped fallback permission is written out in §5.2.
2. **Final bundled DB size.** Estimated 20–25 MiB uncompressed. Under every Play limit (base module
   500 MB) either way, but it determines whether FNDDS's 5,432 survey foods are bundled in v1 or
   deferred. Decide after Phase 2 measures it.
3. **Is `below_loq` ever assignable?** No bulk download has an LOQ column, and a live FDC per-food
   API record returned no `loq` key across 106 `foodNutrients`. The variant exists for Open Food
   Facts `<` modifiers and for a future API that exposes LOQ; until then it will be unused, and the
   discriminator is derived from `derivation_id` instead. Flagged rather than assumed.
4. **Which ~50 nutrients does v1 track?** The list fixes the coverage denominator, the DRI
   transcription workload, and the §7.3 section membership. Needed before Phase 2 finalises the
   ingest.
5. **Cooking-loss modelling for recipes.** Weight change alone systematically overstates vitamin C,
   folate, thiamin and B6 for anything boiled or roasted. v1 ships a raw-basis disclaimer unless
   USDA retention factors turn out to be available in machine-readable form.
6. **Google Play or sideload only?** Play brings the 16 KB page-size requirement (in force since
   1 November 2025 for apps targeting Android 15+), keystore management and signing. Sideloading to
   one device needs none of it. Assume sideload until told otherwise.
