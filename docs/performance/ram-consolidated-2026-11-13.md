# Consolidated RAM optimizations — 2026-11-13

This branch combines the retained changes from the RAM experiments on current main (`c12247d1`, 2.1.0-beta.15). It replaces PR #826. The rejected usage-cache/worker lifecycle, browser-capture/staging and alternate-screen renderer-budget production candidates are excluded. Historical reports retain their original worktree references and validation outcomes; this page describes the consolidated change.

## Review decision — 2026-11-14

The terminal history cache/hydration candidate has been removed. Five filled normal-buffer log views measured 141.5 → 88.8 MiB renderer footprint, but five continuously redrawing alternate-screen agent stand-ins measured 74.7 → 77.2 MiB, with essentially identical heap/backing storage. First Select All changed 56 → 116 ms; search 83 → 123 ms; upward scroll 13 → 117 ms in the log workload. The cache adds a second attach lifecycle, asynchronous search/selection and text-based restoration. That complexity is not justified for the agent TUI case. The runtime and desktop continue keeping the configured history; normal scroll/search/selection remain synchronous. Historical history reports and opt-in harnesses describe the rejected experiment, not shipped behavior.

Lazy modules remain: a fresh paired ten-runtime active cohort measured 536.82 → 391.05 MiB summed physical footprint after settling. At five runtimes it was 278.85 → 219.28 MiB. The fully warmed first runtime was 42.58 → 47.57 MiB, so there is no established permanent saving after every optional module loads. Password first-use cost was 0.67 → 7.71 ms; catalog 6.30 → 9.65 ms. Splitting and demand-loading large optional implementations fits their existing ownership and avoids eviction/worker machinery.

A smaller browser workload (one workspace, two unused start pages and one loaded task page) kept 1 rather than 3 guests. Median summed process RSS was 879.94 → 697.70 MiB; first page-control demand was 22 → 80 ms. The loaded guest and its form state survived. This is RSS accounting, not unique physical RAM, and must not be added to runtime footprint.

The dense 48-job alternate-screen canvas kept 16 rather than 48 views. Settled renderer footprint medians were 336.83 → 174.53 MiB; post-pan medians 349.60 → 246.35 MiB. All PTYs remained live with their original IDs/PIDs and accepted input. This is a dense offscreen workload, not a typical small workspace; the retained policy is a small margin/preload change without an extra resource lifecycle. Baseline timing was noisy because another review ran validation during it; no general latency speedup is claimed.

The parser comparison repeated three launches per variant: retained parser scratch was 512 → 64 KiB per affected view. Median attach times were 125.8 → 122.3 ms and live-write times 11.0 → 10.9 ms. The 20-view scratch reduction is 8.75 MiB; this small fixed write bound preserves the existing attach lifecycle.

These are single paired macOS runs on a shared host with production Electron builds. Runtime footprint cohorts used Node 22.23.3; the Electron profiler/test runner and its fixture runtimes used the host Node 26.9.0 consistently for both variants. Renderer memory comes from Electron, whose engine is unchanged between variants. The five-terminal runs used filled logs and separate alternate-screen stand-ins; they are not authenticated agent turns. Renderer diagnostic samples request GC; runtime physical-footprint samples do not. GPU samples varied and are not claimed as a saving. The dense canvas baseline overlapped another review's validation and is noisy; repeated candidate comparisons must be read accordingly. Raw results: [review measurements](ram-review-2026-11-14-raw.json.gz).

## Included changes

| Change | Measured benefit | Limits and user-visible tradeoff |
| --- | --- | --- |
| Bound terminal parser writes to 16 KiB | 512 to 64 KiB retained parser scratch per affected view; 8.75 MiB across 20 filled views | Applies to large replays. History, UTF-8/ANSI parsing and acknowledgement order stay intact. |
| Create unused browser start-page guests on demand | 15 to 3 guests in a fixture with 12 start pages and 3 loaded pages; about 627 MiB less summed RSS | Only unused start pages. First navigation or automation pays guest startup. Loaded pages retain the existing lifetime policy. RSS is not unique physical RAM. |
| Demand-load optional daemon modules | Ten continuously emitting terminal workspaces: 523.31 to 393.96 MiB summed daemon physical footprint | Most advantage disappears after every optional feature loads. First calls pay deferred initialization. Jobs, trust, networking and capabilities remain live. |
| Reduce canvas overscan and preload entering views | 48 alternate-screen jobs: 48 to 16 mounted views; around 91 MiB less settled renderer footprint and 47 MiB less after initial pans. Long comparisons showed around 90–130 MiB less. | Helps offscreen disposable views, not fully visible overviews or loaded browser guests. Offscreen views remount more often. Very fast pans can briefly expose unready views; early preloading reduced first-fast-pan gaps in these samples. |

These are distinct macOS workloads and metrics, with shared pages and GC/compositor variation. Do not add the savings into a whole-app total or treat them as universal percentages.

Demand loading covers Yjs at file-buffer acquisition/restoration, headless xterm at PTY spawn, usage accounting on request, password handling on credential operations, the curated skills seed on offline catalog fallback, and the native watcher on first subscription. The public `runtime.cjs` entry remains; tarballs include the full split ESM graph and bundled native dependencies. A module stays loaded after use; no worker or idle-module eviction is included.

## Consolidation safety fix

The experimental split builder removed the whole `runtime-modules` directory before each development rebuild. A still-running daemon could subsequently fail to import an old hashed feature chunk. The combined builder retains earlier files, and a regression test loads an earlier entry before rebuilding and then activates its deferred feature. Release staging copies only the current metafile's outputs. A deliberately stale sentinel chunk was excluded from the built tarball and the extracted package's optional features were exercised successfully.

## Reports and reproduction

- [Terminal parser](terminal-ram-2026-11-13-parser.md)
- [Unused browser start pages](browser-ram-2026-11-13-start-pages.md)
- [Runtime module loading](runtime-footprint-round2-2026-11-13.md)
- [Rejected on-demand terminal history experiment](terminal-history-round2-2026-11-13.md)
- [Canvas overscan, including rejected iterations and capture limitations](viewport-overscan-2026-11-13.md)

The runtime profile accepts `RAM2_COMPATIBILITY_VERSION` so historical and current protocol bundles can be measured separately. Set it to the target bundle’s `COMPATIBILITY_VERSION` (1 for these recorded baseline runs; 2 after #831). This is test-handshake metadata, not a compatibility fallback.

The original raw JSON measurement archives are retained as gzip files to avoid tens of thousands of generated lines in the PR. Reproduction scripts and focused opt-in profiles accompany the retained changes. Extract an archive before using tooling that expects plain JSON. The original consolidation made no fresh comparative RAM claim; review reruns above supplement it; the retained runtime/UI source is the measured implementation, with the development-build safety correction above and the terminal-history candidate removed during review.

## Validation after review simplification

Typecheck, dependency rules, desktop/runtime production builds and changed-file ESLint passed. Final affected coverage under Node 22 passed 318 tests across 41 files, plus both browser lifetime and configured terminal-history Electron regressions. An earlier focused terminal/canvas run passed 88 tests. Optional module/files/skills/browser unit coverage passed 230 tests across 27 files; the sandbox initially refused nine file-server socket binds, and that file passed all ten checks with socket permission. Fresh paired runtime, five-terminal log and alternate-screen, browser, dense-canvas and three-launch parser profiles passed.

Thirteen final Electron browser/background/lifetime and terminal history/live-PTY checks passed; the parser profile remained skipped in that functional batch. The new start-page lifetime test exposed a race after returning from a popup: tab selection schedules guest focus for the next animation frame, while the test immediately focused a host button. Added an explicit wait for the selected guest's focus before the independent page-operation focus assertion. The revised lifetime test passed five consecutive runs. No product focus behavior was changed. The twelve-PTY lifecycle retained running jobs and remounted in 213 ms. Cross-platform CI remains the merge gate.

## Combined integration validation

The reviewed updates, loading feedback, browser defaults, Review/repository, worktree deletion and canvas regression were integrated locally with this simplified performance change. Typecheck, layering (1,109 modules), desktop/runtime builds and all 3,367 CI-equivalent unit tests passed (2 skipped), followed by all nine native Cate Connect integration tests in their separate run. Five combined Electron checks passed across browser lifetime, configured terminal history, runtime-stall canvas panning and both Review/repository flows; the opt-in resume diagnostic remained skipped. A one-runtime Node 22 smoke with protocol compatibility 2 exercised real PTY output and all optional first uses (Yjs buffer, passwords, usage, offline skills, network setting and pairing); all completed. This smoke verifies integration, not a new comparative memory claim.

## Original combined validation (before review simplification)

- Node 22.23.3; current main's 2.1.0-beta.15 version is preserved.
- Typecheck, dependency checks, full ESLint (10 existing warnings, zero errors), production desktop/runtime builds and host runtime tarball build passed.
- Full suite: 3,287 passed, 2 skipped, one temporary-HOME `ENOTEMPTY` cleanup failure. Its daemon workspace file passed all three tests in isolation. An earlier run concurrent with the production build had a shutdown-hook timeout instead; that connection file passed all four tests in isolation and passed in the subsequent full run. Neither cleanup test is changed by this PR. A CI-like PATH run excluding installed agent CLIs still hit the connection cleanup-hook timeout (3,287 passed, 2 skipped); the failure is not eliminated by that environment change. Unchanged current main was also tested separately: 3,271 passed, 2 skipped, with a different Cate Connect substituted-key test failure. Thus no entirely green local full-suite run is claimed, and the baseline comparison does not prove the same cleanup failure is unrelated. The full-suite command is therefore recorded with its failure, not described as entirely green.
- Extracted tarball smoke passed with bundled Node 22.22.2: PTY output, Yjs buffer/native watcher, password suggestions, usage accounting and offline skills catalog (950 entries). Ten module files shipped; the stale development sentinel did not. See [packaged smoke results](ram-consolidated-package-smoke-2026-11-13.json).
- All 20 combined Electron regressions passed: browser background automation, loaded-page persistence, start-page first demand/popups, pan/zoom/drag, real TUI lifecycle, configured scrollback, 20-job history hydration/search/selection, and 48-job viewport preloading. The history check observed 142/134/415 ms for Select All/search/concurrent scroll hydration; these are correctness-run observations, not a new paired memory comparison.

Local verification does not replace Linux/Windows CI, remote-latency testing or long authenticated-agent soaks. Earlier experimental failures and measurement limitations remain documented in each report.
