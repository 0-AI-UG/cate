# Terminal client scrollback evaluation — 2026-11-06

Decision: retain the optimization. The desktop terminal now follows the existing workspace `terminalScrollback` setting, whose default is 2,000 lines, instead of unconditionally retaining 5,000. Five filled terminals at the measured grid used about 29 MiB less renderer footprint at 2,000 lines, with unchanged scrolling responsiveness. Custom workspace limits remain supported.

## Experiment

Six fresh isolated Electron launches, two per history limit, in the order 5,000 / 500 / 2,000 / 2,000 / 5,000 / 500. Each launch uses Cate's actual `createTerminalXterm` factory, five terminals with the existing two-view WebGL budget, a fixed 120-column × 30-row grid, and 10,000 short numbered CRLF lines per terminal. A shown 1400 × 950 window runs at DPR 2.

The benchmark loads the factory in the isolated shell and sets each terminal's limit before writing. It does not create PTYs or runtime sessions, so runtime history and process behavior cannot confound the client-history comparison. A separate integration test covers real PTYs, runtime settings, and remounts.

Explicit GC is used before empty/filled retained-heap measurements, only in this diagnostic. No application GC policy was added. Renderer process footprint comes from macOS `vmmap -summary`. Cell backing bytes are counted from xterm's retained line buffers; CDP backing storage covers more than those buffers. Do not add the columns together.

Medians of two runs:

| Client scrollback | Cell backing storage, five terminals | Renderer footprint | JS heap used | CDP backing storage | Scroll p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 500 | 3.64 MiB | 63.6 MiB | 9.57 MiB | 9.44 MiB | 9.50 ms |
| 2,000 | 13.94 MiB | 79.4 MiB | 10.97 MiB | 19.73 MiB | 9.50 ms |
| 5,000 | 34.54 MiB | 108.8 MiB | 13.83 MiB | 40.33 MiB | 9.55 ms |

Reducing 5,000 to 2,000 saves exactly 20.60 MiB of measured cell storage across five terminals at this grid, plus associated objects. The renderer-footprint difference is approximately 29.35 MiB (27%). It is a small two-run sample; these figures are not universal per-terminal costs. Grid width, retained rows, Unicode/attributes, rendering, and allocator state matter. GPU footprints remained variable and were not used to claim a graphics-memory saving.

Parsing the fixed input into all five terminals took median 62.9 ms at 5,000, 55.8 ms at 2,000, and 31.8 ms at 500. This is a synthetic parser measurement, not end-to-end shell throughput. All six scrolling checks passed.

## Why 2,000 rather than 500

The runtime already defaults to retaining 2,000 lines, while the desktop previously retained 5,000 during a continuously mounted view. On reconnect/remount the binding resets its screen from the runtime snapshot, so that additional client-only history was not durable across remounts. Matching the workspace setting removes the mismatch and respects users who configure a different limit.

A 500-line default would save more, but would hide most of the runtime's default history. The current scroll view has no on-demand paging of older history. This change does not add paging or recover output that the runtime has already discarded. Compared with the previous continuously mounted client, the default visible scrollback is reduced from 5,000 to 2,000 lines.

## Implementation and validation

- The xterm factory takes its initial scrollback default from the existing terminal settings contract.
- `TerminalView` applies the workspace setting to its xterm. When the limit changes, it reattaches with that limit so the replacement runtime snapshot and client capacity agree, including after a late settings load.
- The runtime default and runtime retention implementation are unchanged.
- The integration test writes real terminal output, checks that the oldest scrollable client line matches the runtime at the default, checks a custom 5,000-line limit, pans away/back to remount the view, and checks a live decrease to 500.

Validation: six profiling scenarios passed, the real-PTY integration scenario passed, and 32 terminal view/binding unit tests passed. Desktop build, TypeScript, dependency rules, and targeted ESLint passed. The nine-terminal idle and concurrent-output performance scenarios also passed. Idle measured 110 FPS (11.5 ms p95), and output in four terminals measured 118 FPS (9.5 ms p95); neither recorded long tasks. The preceding graphics evaluation measured about 120 FPS, so this rerun does not claim identical frame timing, but shows no material output-interaction regression in the sampled workload.

[Raw measurements](terminal-scrollback-profile-2026-11-06.json), [profiling spec](../../e2e/terminal-scrollback-profile.spec.ts), and [integration test](../../e2e/terminal-scrollback.spec.ts).

Reproduce:

```sh
CATE_SCROLLBACK_PROFILE=1 npx playwright test e2e/terminal-scrollback-profile.spec.ts --workers=1 --output=/tmp/cate-scrollback-profile
npx playwright test e2e/terminal-scrollback.spec.ts --workers=1
```
