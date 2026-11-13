# Consolidated RAM optimizations — 2026-11-13

This branch combines all retained changes from the RAM experiments on current main (`c12247d1`, 2.1.0-beta.15). It replaces PR #826. The rejected usage-cache/worker lifecycle, browser-capture/staging and alternate-screen renderer-budget production candidates are excluded. Historical reports retain their original worktree references and validation outcomes; this page describes the consolidated change.

## Included changes

| Change | Measured benefit | Limits and user-visible tradeoff |
| --- | --- | --- |
| Bound terminal parser writes to 16 KiB | 512 to 64 KiB retained parser scratch per affected view; 8.75 MiB across 20 filled views | Applies to large replays. History, UTF-8/ANSI parsing and acknowledgement order stay intact. |
| Create unused browser start-page guests on demand | 15 to 3 guests in a fixture with 12 start pages and 3 loaded pages; about 627 MiB less summed RSS | Only unused start pages. First navigation or automation pays guest startup. Loaded pages retain the existing lifetime policy. RSS is not unique physical RAM. |
| Demand-load optional daemon modules | Ten continuously emitting terminal workspaces: 523.31 to 393.96 MiB summed daemon physical footprint | Most advantage disappears after every optional feature loads. First calls pay deferred initialization. Jobs, trust, networking and capabilities remain live. |
| Cache live terminal tails, hydrate full history on demand | Fifty normal-buffer log views: 450.50 to 256.50 MiB renderer footprint | Runtime retains configured history. Upward scroll, search or macOS Select All hydrates it; local first hydration was roughly 125–150 ms. Empty-normal-buffer alternate-screen TUIs gain little. |
| Reduce canvas overscan and preload entering views | 48 alternate-screen jobs: 48 to 16 mounted views; around 91 MiB less settled renderer footprint and 47 MiB less after initial pans. Long comparisons showed around 90–130 MiB less. | Helps offscreen disposable views, not fully visible overviews or loaded browser guests. Offscreen views remount more often. Very fast pans can briefly expose unready views; early preloading reduced first-fast-pan gaps in these samples. |

These are distinct macOS workloads and metrics, with shared pages and GC/compositor variation. Do not add the savings into a whole-app total or treat them as universal percentages.

Demand loading covers Yjs at file-buffer acquisition/restoration, headless xterm at PTY spawn, usage accounting on request, password handling on credential operations, the curated skills seed on offline catalog fallback, and the native watcher on first subscription. The public `runtime.cjs` entry remains; tarballs include the full split ESM graph and bundled native dependencies. A module stays loaded after use; no worker or idle-module eviction is included.

## Consolidation safety fix

The experimental split builder removed the whole `runtime-modules` directory before each development rebuild. A still-running daemon could subsequently fail to import an old hashed feature chunk. The combined builder retains earlier files, and a regression test loads an earlier entry before rebuilding and then activates its deferred feature. Release staging copies only the current metafile's outputs. A deliberately stale sentinel chunk was excluded from the built tarball and the extracted package's optional features were exercised successfully.

## Reports and reproduction

- [Terminal parser](terminal-ram-2026-11-13-parser.md)
- [Unused browser start pages](browser-ram-2026-11-13-start-pages.md)
- [Runtime module loading](runtime-footprint-round2-2026-11-13.md)
- [On-demand terminal history](terminal-history-round2-2026-11-13.md)
- [Canvas overscan, including rejected iterations and capture limitations](viewport-overscan-2026-11-13.md)

The original raw JSON measurement archives are retained as gzip files to avoid tens of thousands of generated lines in the PR. Reproduction scripts and focused opt-in profiles accompany the retained changes. Extract an archive before using tooling that expects plain JSON. No fresh comparative RAM claim is made for the consolidation itself; the retained runtime/UI source is the measured implementation, with the development-build safety correction above.

## Combined validation

- Node 22.23.3; current main's 2.1.0-beta.15 version is preserved.
- Typecheck, dependency checks, full ESLint (10 existing warnings, zero errors), production desktop/runtime builds and host runtime tarball build passed.
- Full suite: 3,287 passed, 2 skipped, one temporary-HOME `ENOTEMPTY` cleanup failure. Its daemon workspace file passed all three tests in isolation. An earlier run concurrent with the production build had a shutdown-hook timeout instead; that connection file passed all four tests in isolation and passed in the subsequent full run. Neither cleanup test is changed by this PR. A CI-like PATH run excluding installed agent CLIs still hit the connection cleanup-hook timeout (3,287 passed, 2 skipped); the failure is not eliminated by that environment change. Unchanged current main was also tested separately: 3,271 passed, 2 skipped, with a different Cate Connect substituted-key test failure. Thus no entirely green local full-suite run is claimed, and the baseline comparison does not prove the same cleanup failure is unrelated. The full-suite command is therefore recorded with its failure, not described as entirely green.
- Extracted tarball smoke passed with bundled Node 22.22.2: PTY output, Yjs buffer/native watcher, password suggestions, usage accounting and offline skills catalog (950 entries). Ten module files shipped; the stale development sentinel did not. See [packaged smoke results](ram-consolidated-package-smoke-2026-11-13.json).
- All 20 combined Electron regressions passed: browser background automation, loaded-page persistence, start-page first demand/popups, pan/zoom/drag, real TUI lifecycle, configured scrollback, 20-job history hydration/search/selection, and 48-job viewport preloading. The history check observed 142/134/415 ms for Select All/search/concurrent scroll hydration; these are correctness-run observations, not a new paired memory comparison.

Local verification does not replace Linux/Windows CI, remote-latency testing or long authenticated-agent soaks. Earlier experimental failures and measurement limitations remain documented in each report.
