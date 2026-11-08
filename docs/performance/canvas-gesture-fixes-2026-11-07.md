# Canvas gesture fixes and remaining frame spikes 2026 11 07

Follow-up: [browser loading and surface scheduling](browser-loading-2026-11-07.md) identifies and fixes a child-surface wait. The new mixed-24 verification passes the strict timing gate; cold GitHub GPU-raster stalls remain.

The sustained large-review slowdown is fixed: long hunks now render a bounded set of rows instead of hundreds of thousands of DOM elements. Pan mounting and mouse input are bounded, panels reuse compositor layers during both gestures, and browser hosts move without changing their layout origin. **The complete hitch-free goal is not established**: repeated stress tests have still exposed occasional 30–42 ms mixed-canvas intervals. These are retained as timing failures, not hidden by relaxing the target.

## Final measurements

M5 MacBook Pro, 16 GiB RAM, shown/focused 1400 × 950 window, DPR 2, observed baseline roughly 120 Hz. Two four-second runs per action; fps is the mean and p95 the worse run. Worst interval excludes idle. These are renderer rAF intervals, not GPU execution or presentation times.

| Canvas | Pan fps / p95 ms | Zoom out fps / p95 ms | Zoom in fps / p95 ms | Worst gesture frame ms |
| --- | ---: | ---: | ---: | ---: |
| 6 large diff reviews | 119.9 / 9 | 120.1 / 9.3 | 120.0 / 9.2 | 24.4 |
| 24 mixed panels | 117.7 / 9.4 | 120.1 / 9.1 | 120.0 / 9.3 | 41.5 |
| 6 heavy browser pages | 120.1 / 9.4 | 110.6 / 12.8 | 116.8 / 10.5 | 22.2 |

The final run **did not pass the strict timing gate**: mixed-24 pan repeat 0: max 41.5 ms, p95 9.3 ms, p99 20.2 ms; mixed-24 pan repeat 1: max 41.1 ms, p95 9.4 ms, p99 9.7 ms.

The [initial review profile](canvas-gestures-2026-11-07.md) panned at about 24 fps and zoomed at 20–22 fps, with pan stalls up to 335.4 ms. Live DOM fell from about 391,300 elements to about 8,200. The baseline review workload reached about 3,129 MiB sampled Electron RAM; fixed passes are around 850 MiB during gestures. Warm retained allocations affect exact comparisons.

## Browser coverage and interpretation

Yes, browser panels were tested. The original six-page case used 60 animated gradient boxes per page. The heavier final case has **4,000 DOM elements and a continuously redrawn 1,200 × 800 canvas per page**, drawing 600 colored rectangles each frame. Per-guest counters confirm all six pages continue drawing throughout pan and zoom; pages are not replaced with screenshots or paused for the gesture.

Browser guests run in separate processes and persistent surfaces, so substantial aggregate CPU/GPU work need not block the canvas host. Large reviews previously put hundreds of thousands of elements directly on that host's paint path. Heavy browser zoom has a measurable cost, shown above, but it was not the largest initial frame penalty.

A native mouse test checks surface bounds against canvas slots and real screen-coordinate clicks after zoom 0.55, 1.0 and 0.8 plus pan. Existing browser tests also passed typing at non-default zoom, workspace switching, background automation preserving focus, navigation, snapshots and parked screenshots.

## Retained changes

- `DiffRows.tsx` virtualizes long hunks in 40-row chunks near the review's scroll viewport. Placeholders retain measured heights and estimated horizontal extent. Draft comments, focused content and selected text remain mounted. Unified, split, wrapped and recorded diffs use the same path. Small hunks retain existing behavior.
- `ReviewDiff.tsx` pairs deletion/addition runs once, preserving word highlights across chunk boundaries while removing repeated full-run searches.
- `visibleNodes.ts` reuses the already mounted screen of overscan during pan, replenishes it after 120 ms of quiet, and publishes immediately when genuinely new visible content is exposed. A fresh one-new-node-per-frame budget applies to expansions and swaps, retaining existing nodes in creation order.
- `useCanvasInteraction.ts` coalesces high-rate drag movement into one transform update per frame and flushes the final movement on release. A new drag cancels competing zoom/inertia.
- `Canvas.tsx` promotes individual panels during pan as well as zoom and releases transient layer hints after settling.
- `surfaceRegistry.tsx` positions browser hosts using translation and scale with fixed layout origin and dimensions, retaining clipping, occlusion and same-task alignment.

## Remaining mixed-canvas issue

A traced 32.2 ms interval contained main-frame tasks under 3 ms, ongoing raster-tile work, pending-tree activation and skipped compositor frames. This points toward compositor/raster scheduling but does not establish a complete root cause. Some repetitions were clean; longer verification still found spikes, so a single clean pass is not proof of resolution.

Extending compositor-layer retention and moving the grid via a cached transform did not reliably remove the spike and were reverted. Terminal focus/acceleration and temporary DOM-renderer policies also did not consistently meet the strict target; those production changes were reverted. A focused scene with WebGL2 disabled still produced a 32.8 ms interval. Browser/terminal graphics cost remains worth investigating, but the evidence does not justify attributing every spike solely to browsers or shipping a global acceleration disable.

The browser fallback helper can leave 2D overlay canvases after a failed WebGL addon activation, so total terminal canvas count is not a GPU-context count. The profiler now records actual non-lost WebGL2 contexts separately. Terminal session, rendering policy and PTY behavior were preserved from the pre-task working tree.

## RAM CPU and GPU

| Canvas | Sampled peak RAM MiB | Max action mean CPU % | GPU process RAM MiB | Max action mean GPU process CPU % |
| --- | ---: | ---: | ---: | ---: |
| 6 large diff reviews | 847 | 10.4 | 160 | 3.9 |
| 24 mixed panels | 2564 | 30.0 | 224 | 11.7 |
| 6 heavy browser pages | 2067 | 26.5 | 331 | 11.3 |

RAM sums sampled Electron working sets, including guests, excluding detached runtimes, PTYs and the runner; shared pages can be counted more than once. GPU process RAM is already included in the total and is not all driver/shared graphics memory. CPU is sampled Electron-reported process usage, summed and averaged per action; the table shows the highest action mean. GPU process CPU measures its host CPU work, not hardware GPU utilization. Sequential workload history affects memory.

Hardware device, renderer and tiler utilization from macOS `ioreg` are retained in the JSON. They are whole-machine readings with other applications running, so an exclusively Cate GPU percentage is not established.

## Validation and reproduction

169 targeted canvas, surface, review and terminal unit tests pass. Build, typecheck and dependency checks pass; targeted ESLint has no errors. Native browser positioning/hit testing and review scrolling/draft retention pass. The existing 101-node canvas test passed with zero hidden-panel frames. Browser and review screenshots were inspected. Timing-test failures above remain outstanding.

The profiler records all scenarios before asserting the strict budgets: p95 below 16.7 ms, p99 below 25 ms and every interval below 25 ms. This keeps later measurements available even when an early case fails.

```sh
npm run build
npm run build:runtime
CATE_GESTURE_PROFILE=1 CATE_GESTURE_ASSERT_SMOOTH=1 \
  CATE_GESTURE_SCENARIOS=reviews,mixed-24,browsers-heavy \
  npx playwright test e2e/canvas-gesture-profile.spec.ts
```

`CATE_GESTURE_FOCUS_TERMINAL=1` measures a focused terminal in terminal-containing scenarios. `CATE_GESTURE_DOM_TERMINALS=1` is an isolation helper, not production policy. The benchmark dispatches wheel input once per rAF; it does not measure OS input latency or prove every frame reached the display. Very many small diff hunks can still mount more DOM, and virtualized rows change browser text-search/selection behavior across unloaded content. Arbitrary web apps, video and GPU saturation remain outside this deterministic workload.

[Raw results and diagnostics](canvas-gesture-fixes-2026-11-07.json) include all final timing failures. The complete local trace is `/private/tmp/cate-pan-fixed-trace.json`. Existing unrelated user edits were preserved.
