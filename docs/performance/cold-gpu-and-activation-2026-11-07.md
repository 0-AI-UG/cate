# Cold GPU and activation follow-up, 2026-11-07

The local build now applies the first trackpad delta in the input task and cancels pending wheel, zoom and inertia work when the window loses focus. The installed beta.10 does neither. The longer macOS pause is still not reproduced, including in automated beta.10 trials, so this is a verified scheduling improvement rather than proof that every reported activation pause is resolved.

**The cold GitHub GPU stall is not fixed.** A reduced plain Electron app, containing no Cate code, also stalls during guest loading. No ineffective GPU switch or dependency upgrade was retained.

## Installed beta versus local

Read `/Applications/Cate.app/Contents/Resources/app.asar` and its bundled source map, without modifying the installed app. Its version is `2.1.0-beta.10`; the working tree retains that version but contains unreleased changes.

The installed `useCanvasInteraction.ts` queues every wheel pan through rAF. Its blur handler ends mouse drags but does not cancel queued wheel movement or wheel/zoom animation state. The local handler applies the first wheel delta synchronously, coalesces following deltas, and cancels all pending animation state on blur. The installed main process also lacks the local `deadline-to-synchronize-surfaces=0` fix.

The same DOM-input-task probe against both executable builds gives:

| Build | First wheel delta changes the transform before the input task returns |
| --- | --- |
| Installed beta.10 | No |
| Local build | Yes |

A regression test queues another wheel delta, blurs, refocuses and immediately pans again. It verifies the first new delta applies immediately, interaction state is restored, and no old queued delta appears afterward. All 79 canvas tests pass. Build and typecheck pass; targeted ESLint has no errors (three existing hook-dependency warnings remain elsewhere in the interaction hook).

## Activation-test corrections and limits

Playwright's Chromium implementation enables `Emulation.setFocusEmulationEnabled` by default (`node_modules/playwright-core/lib/coreBundle.js`). Earlier tests therefore observed native window focus changes while the document continued to appear focused. The updated activation and native-input harnesses explicitly disable that emulation. Automated runs verify both the BrowserWindow and document lose focus before the idle interval. The frame collector starts on input and does not keep requesting frames during the idle period. Native injected wheel events now set `hasPreciseScrollingDeltas: true`.

Four-terminal local runs with 15 seconds away and immediate pan remained responsive: the native-input-to-DOM delay was a few milliseconds, and the transform followed within approximately a millisecond. Installed beta.10 trials also did not reproduce the pause: the two wheel samples delivered in 2–5 ms, transformed within 0.1–0.2 ms and had worst rAF intervals of 9.4 ms. **The installed beta's older E2E boot code unconditionally disables background throttling**, so these beta timings cannot rule out its production background-resume behavior. The source comparison and input-task scheduling probe do not depend on that assumption.

A manual physical-trackpad capture window was offered but was not successfully exercised by the user. The native harness records event timestamps, input age, focus, transform changes and frame callbacks, without polling the renderer while idle. OS-input delivery versus DOM response remains distinguishable in a future physical reproduction. No long activation pause is claimed reproduced or conclusively fixed.

## Reliable cold GPU reproduction

HTTP-cache clearing alone is insufficient: the system's per-application GPU cache warms across runs. The profiler can now APFS-clone the official Electron app into a temporary folder and give its app/helper bundles new cache identities. It never clears the user's existing GPU caches. Each profile uses an isolated device/workspace and can also clear only its guest session's shader cache. The clone is removed after the test.

M5, Electron 42.11.18 / Chromium 148, roughly 120 Hz, five-second gestures, one real GitHub browser. These are rAF intervals, not presentation times. Representative cold-cache results:

| Experiment | Homepage pan max ms | Repository pan max ms | Outcome |
| --- | ---: | ---: | --- |
| Default accelerated Graphite, local surface deadline fix | 200.0 | 383.2 | Fails |
| Graphite pipeline precompilation | 200.6 | 175.1 | Fails |
| Accelerated Ganesh | 183.3 | 575.1 | Fails |
| Separate compositor GPU thread | 199.9 | 275.9 | Fails |
| Separate compositor Graphite context policy | 183.3 | 407.9 | Fails |
| Stable Electron 45.2.3 / Chromium 156 | 207.7 | 291.6 | Fails |

Hiding the grid did not remove the stall. Freezing a page before navigation did not protect the new navigation and was rejected. The OpenGL ANGLE experiment crashed its isolated GPU process; it was not retained. The earlier CPU-raster alternative sacrifices sustained zoom throughput and was also rejected. Merely explicitly enabling Graphite is not a fix: the baseline already uses `GraphiteDawnMetal`.

The detailed cold trace has a 200.7 ms raster flush and a 193.9 ms Dawn worker task while Graphite inserts a recording. The original trace's 134.9 ms flush used only 1.8 ms of GPU-main CPU time while another worker ran for about 133 ms. These are blocking GPU-service/worker waits rather than long Cate renderer JavaScript tasks. The [matching Chromium source](https://raw.githubusercontent.com/chromium/chromium/148.0.7778.280/gpu/command_buffer/service/graphite_shared_context.cc) holds the Graphite context lock during recording insertion. This supports the shared GPU-service contention diagnosis; the precise driver/compiler operation inside every worker was not established.

## Framework-only reduction

`e2e/electron-guest-gpu-repro.spec.ts` starts a standalone Electron BrowserWindow with a single webview and a parent div whose transform changes each frame. It loads real GitHub with a fresh GPU-cache identity and a zero surface deadline. It imports no Cate UI, runtime, preload, browser page driver, React or canvas code.

That reduction measured pan at **97.4 fps with a 374.9 ms maximum interval**, and zoom at **109.2 fps with a 249.6 ms maximum interval**. Its collection test passes, but those results fail the smoothness target. This establishes that changing Cate's render subscriptions alone cannot remove this particular cold GPU bottleneck. An engine-level correction or a rendering policy that actually avoids submitting the cold guest GPU work during interaction is still required; no such complete fix is claimed here.

```sh
# Real cold GPU profile; no user cache deletion.
CATE_BROWSER_LOAD_PROFILE=1 CATE_BROWSER_LOAD_COLD_BUNDLE=1 \
  CATE_BROWSER_LOAD_SHADER_COLD=1 CATE_BROWSER_LOAD_REPEATS=1 \
  CATE_BROWSER_LOAD_CASES=github-home,github-repository \
  CATE_BROWSER_LOAD_ASSERT_SMOOTH=1 \
  npx playwright test e2e/browser-load-gesture-profile.spec.ts

# Plain Electron reproduction; currently fails the timing budget.
CATE_GPU_MINIMAL_REPRO=1 CATE_GPU_MINIMAL_ASSERT_SMOOTH=1 \
  npx playwright test e2e/electron-guest-gpu-repro.spec.ts

# Real document focus loss and immediate precise wheel input.
CATE_ACTIVATION_PROFILE=1 CATE_ACTIVATION_CASES=terminals \
  CATE_ACTIVATION_DELAYS=0 CATE_ACTIVATION_AWAY_MS=15000 \
  npx playwright test e2e/canvas-activation-profile.spec.ts
```

[Raw follow-up measurements](cold-gpu-and-activation-2026-11-07.json) retain the rejected comparisons and installed/local scheduling probes. Detailed GPU traces remain under `/private/tmp/cate-github-cold-*-trace.json`. No project Electron dependency was upgraded, no rejected renderer policy was enabled, and the user's unrelated changes were preserved.
