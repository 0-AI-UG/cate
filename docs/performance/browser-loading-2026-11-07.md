# Browser loading and canvas scheduling, 2026-11-07

Follow-up: [cold GPU and activation comparison](cold-gpu-and-activation-2026-11-07.md) verifies the unreleased first-input fix against the installed beta, corrects Playwright's focus emulation, and reduces the remaining cold GPU stall to plain Electron. The cold GPU issue remains unresolved.

The user's GitHub reproduction was valid. Separate guest renderers do not isolate canvas frame pacing from child-surface dependencies or the shared GPU process. The earlier steady-state browser measurements missed navigation work.

## Change

The desktop shell now sets `--deadline-to-synchronize-surfaces=0` before Electron is ready. Explicit command-line overrides remain available for profiling. This lets the canvas activate its frame immediately while a guest is busy, using available guest content. It preserves hardware acceleration, live pages and input.

Chromium's [default deadline is four BeginFrames](https://raw.githubusercontent.com/chromium/chromium/main/components/viz/common/constants.cc), approximately 33.3 ms at 120 Hz. Its [switch implementation](https://raw.githubusercontent.com/chromium/chromium/main/components/viz/common/switches.cc) accepts zero; [surface activation](https://raw.githubusercontent.com/chromium/chromium/main/components/viz/service/surfaces/surface.cc) skips dependency waiting for a zero deadline. The A/B results below support this as the cause of the sustained loading/zoom slowdown. It does not eliminate every source of GPU contention.

## Measurements

M5 MacBook Pro, 16 GiB, Electron 42.11.18 / Chromium 148.0.7778.280, focused 1400 × 950 window, DPR 2, approximately 120 Hz. One browser, five-second gestures, two repetitions per action. A separate 16 ms timer dispatches wheel input while rAF records frame intervals. These measure renderer frame pacing, not actual presentation or OS input delivery. Browser load events, navigation timing and final ready state are recorded.

| Loading workload | Before zoom fps / worst p95 ms | Fixed zoom fps / worst p95 ms | Fixed worst frame ms |
| --- | ---: | ---: | ---: |
| 16,000 rows, repeated script and forced layout | ~56 / 41.6 | ~120 / 9.1 | 9.4 |
| Same work plus 16 large JPEGs | ~56 / 41.6 | ~120 / 8.9 | 9.4 |
| GitHub homepage, cold HTTP cache | 97.2 / 33.3 | 120.0 / 9.1 | 9.4 |
| GitHub VS Code repository, cold HTTP cache | 106.8 / 9.3 | 120.0 / 9.0 | 9.4 |

Network waiting alone stayed approximately 120 fps before the change. It was guest rendering work, rather than an outstanding request by itself, that triggered the sustained slowdown. Fixed script/combined pan runs also stayed approximately 120 fps, worst interval 9.4 ms. Warm GitHub pan and zoom runs stayed approximately 120 fps, worst interval 9.4 ms.

GitHub pages were loaded from `https://github.com/` and `https://github.com/microsoft/vscode`, using a fresh isolated unsigned-in browser profile. Both completed successfully. Cold means the guest session HTTP cache was cleared before that action; it does not mean every system, shader or process cache was cold. Signed-in pages and extensions were not covered.

## Remaining cold-load GPU hitch

**The complete hitch-free target remains unmet.** With the surface fix, cold GitHub pan still had a 41.9 ms homepage interval and a 125 ms repository interval; warm repeats were clean. Before the fix, cold homepage/repository pan reached 141.8/150.1 ms.

The baseline GitHub trace contains a roughly 135 ms GPU-process raster flush (`RasterDecoderImpl::DoEndRasterCHROMIUM::Flush`), while no host-renderer main-thread task exceeded 30 ms. The local combined trace instead shows a busy guest renderer and a lightly loaded host: host main tasks at most 3.3 ms despite ~42 ms frame intervals. This identifies two distinct coupling paths and prevents attributing every pause to React or browser loading events.

An isolated CPU-rasterization comparison reduced cold pan maxima to 16.7–17.4 ms, but GitHub zoom fell to 63–69 fps, with roughly 32–46% sampled aggregate Electron CPU versus 6–10% in the corresponding hardware-raster fixed runs. This tradeoff was rejected; no global rasterization disable was added. GPU execution/presentation timing and exclusive hardware utilization were not established by these tests.

Sampled fixed GitHub cold actions peaked around 921–1027 MiB summed Electron working sets, including 140–188 MiB in the GPU process. The combined local zoom sample peaked around 1436 MiB versus 1450 MiB before, with sampled mean aggregate CPU around 10.5% versus 10.6%. These are process samples, include shared-memory double counting, and are affected by workload history; they do not establish a memory reduction from this scheduling change.

## macOS activation

The new native-input test activates Finder, verifies Cate loses window focus, then reactivates Cate and sends native wheel or middle-drag events 0, 50 or 200 ms after the window's focus event. Production-like background switches are used, and the normally hidden E2E dock icon is shown. Empty, settled-browser and busy-browser scenes each cover both actions and all delays: 18 samples before and 18 after.

The separate activation pause was **not reproduced**. Before: first native input reached the DOM in 1–10 ms and the transform followed within 0.2–1.8 ms. After: delivery was 1–9 ms and transform response within 0.2–4.2 ms; worst subsequent rAF interval was 13.7 ms. This does not prove the user's Cmd+Tab/physical-trackpad case is resolved: activation is programmatic and input is injected at an empty canvas point. No speculative focus-path change was made.

## Validation and reproduction

The native browser positioning test moves and zooms an actual webview, checks screen-coordinate clicks, then blocks its renderer for 2.5 seconds and captures the moved page before it unblocks. The green page pixels remain visible at the new position, and native clicking works afterward. This guards against improving host timing by producing a blank browser surface.

The built production startup path also passed the strict loading budget with **three concurrent browser loads**: script and combined workloads, pan and zoom, all approximately 120 fps. Build, typecheck, targeted ESLint and dependency checks pass.

The retained startup fix also passed the strict steady-state budgets in 12 gesture runs (two repetitions per action). This supersedes the previous report's outstanding mixed-24 timing failure for this verification run; it does not erase the cold GitHub failure above.

| Canvas | Pan fps / worst p95 ms | Zoom out fps / worst p95 ms | Zoom in fps / worst p95 ms | Worst interval ms |
| --- | ---: | ---: | ---: | ---: |
| 24 mixed panels | 120.0 / 10.1 | 120.1 / 10.0 | 120.1 / 9.8 | 17.9 |
| 6 heavy browser pages | 120.1 / 9.7 | 111.0 / 12.7 | 117.7 / 10.5 | 20.7 |

```sh
npm run build
CATE_BROWSER_LOAD_PROFILE=1 CATE_BROWSER_LOAD_ASSERT_SMOOTH=1 \
  CATE_BROWSER_LOAD_CASES=script,combined \
  npx playwright test e2e/browser-load-gesture-profile.spec.ts
CATE_BROWSER_LOAD_PROFILE=1 \
  CATE_BROWSER_LOAD_CASES=github-home,github-repository \
  npx playwright test e2e/browser-load-gesture-profile.spec.ts
CATE_ACTIVATION_PROFILE=1 npx playwright test e2e/canvas-activation-profile.spec.ts
npx playwright test e2e/browser-canvas-position.spec.ts
```

Use `CATE_BROWSER_LOAD_SURFACE_DEADLINE=4` for the original deadline, `CATE_BROWSER_LOAD_COUNT` for concurrent guests, and `CATE_BROWSER_LOAD_CPU_RASTER=1` only for the rejected comparison. Strict budgets are p95 <16.7 ms, p99 <25 ms and every interval <25 ms. Remote cold-load results still fail the last criterion; a successful collection test is not a smoothness pass.

Raw A/B measurements (`browser-loading-2026-11-07.json`; local raw samples) retain frame intervals, process samples, guest load audits and activation probes. Full traces remain locally at `/private/tmp/cate-browser-load-trace.json` and `/private/tmp/cate-github-load-trace.json`. Earlier steady-state results and remaining mixed-canvas spikes are documented in [the previous report](canvas-gesture-fixes-2026-11-07.md).
