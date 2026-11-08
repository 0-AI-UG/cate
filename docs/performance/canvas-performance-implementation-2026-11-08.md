# Canvas performance implementation follow-up, 2026-11-08

The main checkout now contains numeric surface-geometry caching and the independent Monaco initialization fix. Deferred semantic detail rendering and shared browser GPU hosting remain isolated prototypes. Existing local changes and the main Git index were preserved; no dependency or version changes were made.

## Applied changes

**Geometry:** reuse numeric viewport geometry rather than repeatedly querying DOM rectangles and computed styles. Preserve clipping, occlusion, portal companions, logical browser sizes and synchronous input alignment. Invalidate on real source/ancestor/class/style/resize/scroll/portal/stylesheet changes; use the uncached path for active geometry animations. Newly started WAAPI animations are discovered on the next sync; direct CSSOM edits without DOM mutations are not intercepted. Avoid repeated no-op canvas promotion writes. A measured duplicate-pass regression in the first hardened version was fixed and its results excluded.

**Editor initialization:** repeated editor mounts no longer redefine the same global Monaco theme or flush the shared font cache unnecessarily. Real theme and font changes still apply. This does not add a new process or defer first-time module evaluation, and it is independent of semantic rendering levels.

Source commits: geometry `adf07251` plus `8d6a78b0`; standalone editor fix `6f69b2ca`. The main checkout contains these patches without committing unrelated local work.

## Final foreground cache comparison

Apple M5, 16 GiB, macOS (Darwin 25.3.0), Electron 42.11.18, Chromium 148.0.7778.280, DPR 2.

Fresh local-change baseline `d1cb9a9e`; same runtime, hardware, input producer and profiler. One trial per scenario/action, four seconds of movement plus one second of recovery; all 12 trials retained native window focus throughout sampled resources. Restore focus only before measurement, never during it. Renderer task duration covers the gesture and recovery; these are rAF intervals rather than measured display presentation.

| Workload | Renderer task time, baseline → cached | p95 interval, baseline → cached |
| --- | ---: | ---: |
| 24 mixed panels, pan | 1166 → 1097 ms | 9.1 → 9.2 ms |
| 24 mixed panels, zoom out | 2033 → 1956 ms | 9.0 → 9.2 ms |
| 24 mixed panels, zoom in | 1972 → 1546 ms | 9.0 → 9.0 ms |
| Six animated browser panels, pan | 803 → 785 ms | 9.2 → 9.0 ms |
| Six animated browser panels, zoom out | 1267 → 1192 ms | 13.0 → 13.2 ms |
| Six animated browser panels, zoom in | 1178 → 1212 ms | 11.3 → 11.3 ms |

DOM rectangle/style reads fell about 97% overall (91–99% by case). Mixed-panel renderer task time fell about 11% in aggregate. Browser-heavy renderer work was approximately unchanged overall. Geometry helper time fell about 50% in mixed cases and 29% in browser-heavy cases. This is a CPU/work reduction, not a solution to browser GPU stalls or a consistent frame-pacing improvement. Mixed pan had a 32.6 ms worst interval versus 22.1 ms baseline; the other worst intervals varied as well. With one trial per case, tail improvements or regressions cannot be generalized.

Whole-app CPU counter deltas over the sampled interval were 1.05 / 2.33 / 2.82 logical-core equivalents for baseline mixed pan/out/in and 1.01 / 2.33 / 2.44 cached. Browser-heavy values were 1.64 / 2.83 / 2.38 versus 1.63 / 2.88 / 2.49. Working sets fluctuated without a reliable RAM saving. Whole-device GPU utilization was broadly similar. Complete CPU, RAM and GPU readings are in the companion JSON and raw trial files. CPU counter coverage is the first-to-last resource sample, not the entire gesture; summed working sets can double-count shared pages, and AGX readings include other applications.

## Semantic detail restoration: improved, not integrated

The prototype retains mounted state, keeps declared browser surfaces available for automation, prioritizes focused requests, cancels obsolete work, pauses hidden-canvas admission, and serializes actual view readiness and subsequent reveal work. It warms a shared view module when its type becomes known, rather than unexpectedly evaluating it on later zoom. The creation cost is measured separately. Readiness hooks stay in the desktop UI; session and resource ownership are unchanged.

Combined with geometry and the editor fix, the final untraced foreground test handled all 263 cold and 69 warm pan inputs and retained native focus with zero blur events. All 48 detail markers, 16 actual Monaco editors and 16 xterm hosts appeared; no fallback deadline was used. Cold completion took 2106 ms with a 58.0 ms worst interval; warm completion took 173 ms with a 34.2 ms worst interval. Creation separately took 1976 ms and contained a 57 ms module-initialization long task. No recovery long task exceeded 50 ms, but frame gaps still exceeded the 25 ms target. Browser guest identity, automation and unsaved field preservation passed.

The prototype therefore remains outside the main checkout. Earlier trials saw 100–133 ms hitches; the final proof still recorded 58 ms and misses the target. The protocols differ, so this is not a controlled claim of the size of that improvement. Traces identify first-terminal GPU setup and forced editor/layout work; more wrapper scheduling alone is not sufficient. Latest prototype `a71b5515` and its test artifacts remain reviewable in the levels and combined worktrees. Collection tests passing must not be interpreted as a smoothness pass.

## Shared browser-host research

A single separate Electron host/GPU service now owns 1, 4 or 8 browser producers, rather than starting one Electron app per page. All sources use the same 900×650 viewport, DPR 2 and 60 fps JPEG transport in matched controls. All six memory cases verified actual pixels, click forwarding, active frame updates, bounded mailboxes, one shared producer GPU, distinct host/source GPU services in isolated mode, and eventual exit of all 59 sampled process PIDs.

| Active pages | Same-process mean / peak | Shared isolated host mean / peak |
| --- | ---: | ---: |
| 1 | 620 / 692 MiB | 830 / 848 MiB |
| 4 | 982 / 1077 MiB | 1205 / 1274 MiB |
| 8 | 1494 / 1692 MiB | 1558 / 1696 MiB |

The one- and four-page cases suggest roughly 200–225 MiB shared overhead, rather than that cost repeating per page. The small eight-page difference is not evidence of negligible overhead: source renderer working sets, browser heaps and GPU/readback allocation differed. All eight distinct source renderer PIDs were present in both modes. Budget conservatively around the earlier shared overhead until repeated real-page profiling establishes a reliable distribution. CPU counter samples suggest similar overall processing costs; coverage and working-set variance prohibit an energy or memory-efficiency claim.

Because foreground focus was lost in four memory runs, those rows are valid for the explicitly labelled memory study only. They are not evidence of multi-panel pan/zoom smoothness. The memory fixture runs make no GitHub cold-load claim.

A separate strict one-page GitHub proof holds the first successful main-frame HTTP response until movement is running, then requires committed GitHub frames to be installed during the active measurement. The same-process parent had a 275 ms maximum interval; isolation had 9.4 ms. The isolated page's first actual remote frame arrived at +489 ms within the five-second gesture, so network waiting cannot explain the responsive host. Its working-set peak was 1135 MiB versus 906 MiB control. The webpage itself still freezes; canvas motion is protected.

This remains research code, not the production browser backend. Same-process OSR control teardown needed forced cleanup at four and eight pages; isolated eight-page shutdown may have used a three-second worker kill fallback, although all process exits were verified. Keyboard/IME, accessibility and full browser lifecycle integration remain absent. Strict multi-page GitHub load performance is unvalidated. Prototype commit `c915fbc7` and a detailed report remain in the isolation worktree.

## Validation and scope

- Main checkout: 145 tests across 20 files, typecheck, dependency checks and production build pass. Targeted ESLint has zero errors and one existing Canvas ref warning. Whitespace checks pass.
- Combined candidate: 159 tests across 23 files, typecheck, dependency checks and build pass; two foreground browser/recovery E2Es pass correctness and collection, but the smoothness gate is not met.
- No experimental scheduler or retained-shared-texture backend was added to the main checkout.
- The physical macOS trackpad/return-to-app input delay is not tested by these synthetic DOM/CDP gestures and is not claimed fixed here.

Manifest and raw files: `output/canvas-followup-manifest.json` and `output/canvas-followup/canvas-followup-1794134338/`. The original architecture comparison remains in `canvas-architecture-experiments-2026-11-08.md`.
