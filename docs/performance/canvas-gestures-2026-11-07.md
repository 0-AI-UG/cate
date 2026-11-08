# Canvas zoom and pan performance analysis 2026 11 07

Follow-up implementation and remaining timing failures: [Canvas gesture fixes](canvas-gesture-fixes-2026-11-07.md).

Canvas gestures do **not** yet stay smooth regardless of panel content. Six large diff reviews reduce pan to about 24 fps and zoom to 20–22 fps. One large review introduces a 69 ms pan hitch. A 24-panel mixed canvas also has intermittent pan stalls, up to 57.8 ms in the settled validation. Terminals, loaded code editors, and deterministic animated browser pages generally sustain about 120 fps in the smaller canvases measured here.

## Frame time results

All times are milliseconds. Each p95 is the worse of two four-second runs, except the single-review check, which has one run per action. Worst frame excludes idle. These are renderer requestAnimationFrame intervals, not GPU execution times or proof that every frame reached the display.

| Canvas | Pan p95 | Zoom out p95 | Zoom in p95 | Worst gesture frame |
| --- | ---: | ---: | ---: | ---: |
| Empty | 9.1 | 9.2 | 9 | 11 |
| 6 terminals with scrollback | 9 | 9.2 | 9 | 10.7 |
| 6 editors | 9 | 9.3 | 9.2 | 11.7 |
| 6 animated browser pages | 9.2 | 9.3 | 9.1 | 11.7 |
| 6 mixed panels | 9.2 | 9.2 | 9.1 | 14.9 |
| 24 mixed panels | 10 | 9.1 | 9.2 | 57.8 |
| 6 large diff reviews | 42.3 | 49.4 | 56.1 | 335.4 |
| 1 large diff review | 9 | 10.5 | 9.5 | 69 |
| 6 terminals with live output | 9.2 | 9.2 | 9.1 | 54.1 |

The 24-panel validation pan averaged 115.8 fps but had five frames over 25 ms across eight seconds, including one over 50 ms. Six reviews had 192 pan frames over 25 ms and two initial stalls above 300 ms. Review zoom-in averaged 19.9 fps, with p95 up to 56.1 ms and 93 frames over 50 ms. Averages alone would conceal the mixed-canvas and single-review hitches.

## RAM CPU and GPU

RAM is the sampled sum of Electron process working sets, including browser guest renderers. It excludes detached runtime daemons, PTYs, and the test runner; shared pages can be counted more than once. GPU process memory is already included in the total and is not a complete accounting of driver or shared graphics allocations. These are warm sequential workload measurements, not additive per-panel costs or evidence of leaks.

CPU columns use Electron's reported process CPU percentages: approximately one-second samples, summed across app processes, then averaged per action. The table shows the highest action mean. The existing performance monitor also samples CPU, so intervals vary; these values are indicative rather than exact time-weighted CPU budgets. GPU process CPU measures its host CPU work, separately from hardware GPU utilization.

| Canvas | Sampled peak RAM MiB | Max action mean CPU % | GPU process RAM MiB | Max action mean GPU process CPU % |
| --- | ---: | ---: | ---: | ---: |
| Empty | 565 | 3.7 | 127 | 2.1 |
| 6 terminals with scrollback | 658 | 4.6 | 171 | 2.3 |
| 6 editors | 738 | 6.3 | 173 | 2.9 |
| 6 animated browser pages | 1783 | 21.9 | 213 | 8.9 |
| 6 mixed panels | 1179 | 10.1 | 215 | 4.6 |
| 24 mixed panels | 2171 | 33.5 | 266 | 15.9 |
| 6 large diff reviews | 3129 | 11.3 | 154 | 1.0 |
| 1 large diff review | 1279 | 12.0 | 139 | 2.1 |
| 6 terminals with live output | 3347 | 6.1 | 158 | 2.6 |

Mixed-24 memory figures above come from the broad launch before the review workloads. In the validation launch after six reviews, sampled mixed-canvas RAM remained as high as 3,347 MiB during gestures; history and retained allocations materially affect memory. No forced GC was used.

macOS hardware GPU `Device Utilization %` was also sampled through `ioreg`. Broad-run action means were 48–68% on the empty canvas and 61–74% for 24 mixed panels. In settled review validation, action means were 33–42%. These are **whole-machine** readings with other applications running, so they cannot establish Cate's GPU utilization or an attributable GPU delta. Per-action readings and renderer/tiler statistics are retained in the JSON. The review bottleneck is supported by renderer tracing rather than these global readings.

## Findings and recommended order

1. **Bound the number of rendered diff rows.** One 2,500-line modified file creates about 65,400 live DOM elements in one review; six reviews create about 391,300. `GitReviewView.tsx` lazily fetches a file when its section approaches the viewport, but `ReviewDiff.tsx` maps every line of a loaded hunk into DOM. File-level lazy fetching therefore does not bound the rendering cost of one large hunk. Virtualize diff rows, including split view, wrapped lines, and inline comments, then rerun the single- and six-review cases.

   The four-second review zoom trace contains about 4,013 ms in renderer main-frame work. Paint intervals cover 1,755 ms after removing nesting within Paint events; FunctionCall intervals cover 539 ms, Layout 279 ms, and Layerize 261 ms. These categories can overlap and must not be summed. This is substantial paint and layer work over an enormous DOM, not evidence that React rerenders alone explain the slowdown. Examine gesture-start style invalidation as well: pan starts produced 318–335 ms stalls with six reviews and 69 ms with one.

2. **Reduce pan stalls when entering new content.** `visibleNodes.ts` defers culling changes during zoom, but publishes immediately during pan. In the 24-panel case, the mounted set grows from 20 nodes to 22–24, including more Monaco and xterm instances. The traced mixed pan also shows main-frame work up to 23.6 ms, FunctionCall work up to 14.5 ms, and a major GC up to 19.5 ms. Those are candidate contributors; the trace does not prove which operation caused the separate untraced 57.8 ms interval. Apply a bounded per-frame mount queue to newly visible panels during pan and verify both hitches and content appearance. The existing staged mount limit grows and does not reset into a fresh budget for each later cull expansion.

3. **Preserve browser alignment while reducing its geometry work.** Six browsers spend roughly 248–262 ms over a four-second pan in `syncPanelSurfaces`; the mixed-24 validation spends about 254 ms. This path reads slot/ancestor geometry and synchronizes fixed browser surfaces after canvas transforms. It is measurable overhead but did not produce sustained jank in the six-browser case. Cache stable clipping and occlusion inputs where justified by a trace; retain same-frame alignment and browser interactivity.

4. **Make smoothness an explicit regression target.** `canvas-scale-perf.spec.ts` currently permits p95 below 200 ms and fps above 9, so it cannot enforce a smooth canvas. Keep functional CI separate from hardware-specific profiling. On this roughly 120 Hz run, target p95 near the 8.3 ms refresh interval, p99 below 16.7 ms, and no gesture-start or mount stalls above 25 ms. Also validate a 60 Hz target and slower hardware. A renderer rAF profile should be paired with presentation timing and real input-latency measurements before claiming perceptual smoothness.

## Method and reproducibility

Apple M5 MacBook Pro, 10 CPU cores, 16 GiB RAM; visible focused 1400 × 950 Electron window, DPR 2, observed baseline about 120 Hz. Production desktop and runtime bundles were rebuilt from base commit `39771c6` plus the existing dirty working tree. Existing user changes were preserved. All profiles used temporary isolated homes and fixture projects; no user workspace was rearranged.

Workloads: six terminals each filled with 3,000 lines; six editors opening a 2,500-line TypeScript file; six local browser pages each with 60 animated gradient boxes; mixes split evenly among terminal/editor/browser; review fixtures changing all 2,500 lines in a committed TypeScript file. Live-terminal workload prints about 20 lines per second per terminal, not an unbounded output flood. Panels use default sizes and overlap on a three-column canvas.

The benchmark dispatches wheel events to the real canvas wheel handler once per renderer animation frame: fractional two-axis deltas for pan, Ctrl+wheel for zoom. Zoom starts at 0.8 for zoom-out and 0.35 for zoom-in. Fast runs reach the minimum zoom of 0.3 during zoom-out; slower review runs traverse less distance because input is frame-paced. This is a rendering stress measurement, not fixed-rate OS input or end-to-end latency. It bypasses native browser-guest hit testing, and does not measure right/middle drag, inertia, toolbar zoom, presentation drops, image/PDF previews, video, very large browser applications, or large multi-worktree territory scenes.

The broad and additional passes used a 400 ms reset settle; inspection of transform endpoints showed that a previous zoom could still be settling into the next reset. The benchmark now explicitly waits for `canvas-zooming` to end. The settled validation independently reproduces review failures and mixed pan stalls; its frame figures are used above for those cases. Small-panel results are exploratory runs, not identical-path zoom comparisons. The trace-enabled samples include tracing overhead, but untraced repeat samples also reproduce review jank. A single large review was checked in a separate fresh launch with the corrected settle barrier.

Run the opt-in profiler:

```sh
npm run build
npm run build:runtime
CATE_GESTURE_PROFILE=1 npx playwright test e2e/canvas-gesture-profile.spec.ts
```

Optional variables: `CATE_GESTURE_SCENARIOS` (comma-separated), `CATE_GESTURE_ACTIONS`, `CATE_GESTURE_COUNT`, `CATE_GESTURE_REPEATS`, and `CATE_GESTURE_OUTPUT`. Set `CATE_GESTURE_TRACE` to an absolute trace destination, with `CATE_GESTURE_TRACE_SCENARIO` and `CATE_GESTURE_TRACE_ACTION` to select a gesture (defaults: mixed-24 pan). Traces can be large.

Raw measurements, per-action summaries, hardware metadata, and extracted trace summaries are in [canvas-gestures-2026-11-07.json](canvas-gestures-2026-11-07.json). Full local traces are `/private/tmp/cate-canvas-pan-trace.json` and `/private/tmp/cate-review-zoom-trace.json`; these temporary files are not committed.

Validation: four isolated profiling passes completed; ESLint for the new profiler and application typecheck passed. No production rendering behavior was changed. The opt-in test records timings and checks that gestures move the canvas; completion of the test is not a smoothness pass.
