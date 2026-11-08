# Graphics optimization evaluation — 2026-11-06

Decision: keep both changes. The matching five-terminal workload's GPU-process footprint fell by 91.7 MiB (19%), and the empty canvas fell by 80.4 MiB (20%). The new build eliminated unused territory canvases and reduced terminal canvases from ten to four, with no material responsiveness regression in the measured scenarios.

## Changes retained

- `WorktreeTerritoryLayer` subscribes to membership without mounting its renderer until a worktree group is present. Removing the last group unmounts the renderer, disposing its GL resources, subscriptions, and frame scheduling. Existing rendering and context recovery paths remain inside that renderer.
- Terminal views use at most two WebGL renderers per client instead of six; additional views use xterm's existing DOM renderer. This is the existing cap mechanism with a smaller budget, not a new rendering path.

Browser page discarding was not implemented: it needs separate eligibility behavior for forms, media, and automation. The earlier profile demonstrated that hiding already reclaims much of browser graphics memory.

## Matching visible-window memory and interaction runs

Fresh isolated HOME/device profiles, shown 1400 × 950 window, DPR 2, five overlapping terminals with 3,000 output lines each. The profiling spec was extended with 180 animation frames split between panning, zooming, and scrolling terminal history. Both builds ran the same instrumentation. The baseline used the existing pre-change build; the second run followed a successful desktop rebuild. No existing user workspace was altered.

| Measurement | Before | After |
| --- | ---: | ---: |
| Empty-canvas GPU footprint | 396.0 MiB | 315.6 MiB |
| Five-terminal GPU footprint | 482.1 MiB | 390.4 MiB |
| Territory canvases without worktree groups | 2 | 0 |
| Terminal canvases in five-terminal workload | 10 | 4 |
| Pan/zoom/scroll frame interval, p95 | 9.2 ms | 9.2 ms |
| Pan/zoom/scroll frame interval, maximum | 9.4 ms | 9.9 ms |

Footprint is `vmmap`'s macOS physical footprint, sampled sequentially per process after a three-second settle. These are single matching runs, not repeated-run medians. Driver allocation, caches, and startup conditions are variable: the previous exploratory profile had substantially different absolute baselines. Do not generalize these savings to every machine, count them as unique physical RAM across processes, or assign the entire reduction to either change individually. The surface counts independently verify that the intended allocations were removed.

## Terminal output and territory checks

The existing nine-terminal test ran before and after with concurrent output in four terminals:

| Measurement during output | Before | After |
| --- | ---: | ---: |
| FPS | 120 | 120 |
| Frame interval, p95 | 9.2 ms | 9.2 ms |
| Long tasks recorded | 0 | 0 |
| Peak renderer CPU | 11.7% | 13.3% |

The small peak renderer CPU increase is a potential DOM-rendering tradeoff, without observed frame degradation here. These tests do not establish equal maximum output throughput or performance for every TUI/font/workload. Unlike the matching graphics profile, the existing performance harness uses its normal E2E window configuration.

After the rebuild, territory engagement plus pan, zoom, and node-move stress tests all passed. The engagement check observed four live worktrees, 20 tagged nodes, four groups, and an active GL backend. The movement scenarios retained approximately 120 FPS, recorded no long tasks, and produced territory draws. Together with the membership lifecycle unit test, these guard against suppressing useful territory rendering while avoiding the empty allocation.

Validation completed: desktop build, TypeScript check, dependency rules, targeted ESLint, 22 unit tests across territory and terminal views, both matching graphics lifecycle runs, two baseline terminal performance tests, and six optimized terminal/territory performance tests. No change was reverted because both retained changes had concrete allocation benefits and passed these checks.

Raw before/after measurements (`graphics-optimization-evaluation-2026-11-06.json`; local raw samples) include all lifecycle stages, memory-map region summaries, and canvas counts. Reproduce with the opt-in [graphics profiling spec](../../e2e/graphics-memory-profile.spec.ts), using separate output directories per build, plus the existing `perf-stress.spec.ts` nine-terminal scenarios and `worktree-territory-perf.spec.ts` scenarios.
