# Canvas overscan and terminal RAM — 2026-11-13

This experiment is isolated on `perf/ram-viewport-overscan`, based on `2b25f229` (the reviewed round-two branch). It includes none of the rejected usage-worker changes. The user's primary checkout is untouched.

## Change and iterations

The desktop previously mounted a full viewport of overscan on each edge: up to nine viewport-sized areas. Terminal/editor/review views outside that range are already disposable client caches; terminal jobs and other authoritative sessions remain in the runtime. Browser/native surfaces, focused nodes and pinned nodes are exempt.

The candidate reduces the margin to one quarter-screen. It also preloads nodes when they **enter that margin during pan**, rather than waiting until new content actually becomes visible. Existing creation-order rendering, one-new-node-per-frame staging, zoom settling, native-surface exemptions and session ownership stay intact. Views leave the mounted set sooner and can reattach more often. The change neither suspends jobs nor lowers authoritative history retention.

Three iterations were measured:

- Margin reduction alone: 48 mounted views became 16 and renderer footprint fell, but slow panning introduced 12 missing-content frames. Rejected.
- Replenish at the inner half of the smaller margin: no slow-pan missing frames in two runs, but 10 missing frames on the first fast pan. Superseded.
- Replenish at the whole smaller margin: no slow-pan missing frames; first fast pan had one and zero missing frames in the two final runs, versus 12 in each original-policy run.

## Method and scope

Apple Silicon macOS 26.3, Node 22.23.3, Electron 42.11.16 and xterm 5.5.0. Real built Electron app, fresh HOME/device profile, one runtime, 48 real PTYs running offline alternate-screen TUI stand-ins. Each TUI redraws its actual terminal grid at 5 Hz and accepts raw input; every runtime screen is asserted to be alternate-screen before profiling. Panels occupy an 8 by 6 grid, each 640 by 400 with gaps, around a 1600 by 1000 window. This exercises terminals beside the viewport, not overlapping views or fabricated history caches. About nine cards intersect the viewport, including partial cards.

This is a dense multi-agent canvas, not a claim about the typical workspace. Fully visible overview content still needs its views. A small canvas whose panels all fit on screen has little to gain. No authenticated agent turns, production user data or browser-page eviction are involved.

`/usr/bin/footprint -f bytes` records physical footprint, including compressed pages. Each initial and post-pan stage has three samples separated by two seconds; table values are stage medians, then medians across launches where specified. No GC is forced for those comparisons. Renderer, GPU and runtime footprints can overlap through shared pages, so their deltas are not added into a whole-app RAM promise.

The profiler drives pan offsets at rAF boundaries (90 frames at 15 pixels/frame, then 45 at 60 pixels/frame). It records whether each geometrically visible node has a mounted xterm whose first screen line contains the TUI marker. Missing-content frames are a diagnostic proxy, not OS input-to-photon or display-presentation measurements. React refs are inspected without retaining old xterms. Frame timing includes that inspection and should not be treated as a standalone FPS benchmark.

## Measurements

Final short comparison, two launches per policy (baseline-a/b and full-prefetch-soak/b, before their optional repeated cycles):

| Metric | Original | Candidate |
| --- | ---: | ---: |
| Mounted terminal views at the sampled viewport | 48 | 16 |
| Renderer, settled, MiB | 305.10 | 213.64 |
| Renderer after the initial pans, MiB | 311.45 | 264.61 |
| Slow-pan missing frames, each launch | 0 / 0 | 0 / 0 |
| First fast-pan missing frames, each launch | 12 / 12 | 1 / 0 |

That is about **91 MiB less renderer footprint initially and 47 MiB less after the first pans** in this workload. Launch-to-launch variation is substantial: original settled renderer medians were 321.56 and 288.63 MiB; candidate medians were 207.75 and 219.52 MiB. Small samples do not establish precise universal percentages.

The matched eight-cycle runs ended at 357.53 MiB renderer for the original policy and 307.91 MiB for the candidate (about 50 MiB lower). Neither eight-cycle trajectory reached a demonstrated plateau. In those repeated cycles the original had no missing frames; the candidate had one missing fast-pan frame in two of eight cycles, with no slow-pan gaps. The candidate therefore does not eliminate every exposure gap and is not uniformly better on that metric. It avoids most first-fast-pan misses while adding rare brief misses during these repeated gestures.

GPU figures fluctuate sharply while compositor resources settle; no GPU saving is claimed. Runtime code is unchanged, and its sample differences vary with GC timing. The long-run check below is needed because higher view churn could erase the initial saving.

A first matched 20-cycle comparison recorded **432.24 MiB original versus 313.86 MiB candidate** over the final ten natural samples (118.38 MiB less). Candidate samples in the latter half stopped rising monotonically and ranged around 304–328 MiB. WebGL attempts/failures were 4/0 original and 6/0 candidate, so a failed-context fallback does not explain this comparison.

Separately labelled diagnostics after those natural samples forced two GCs. Renderer footprint then measured 178.88 MiB original and 118.22 MiB candidate (60.66 MiB difference). The JS heaps were 26.60/17.44 million bytes and embedder heaps 31.31/11.32 million bytes. This supports lower live working data, but these GC figures are **not product RAM results**.

That first candidate long run completed the memory, PTY and runtime-input checks and wrote its complete data, then failed its optional final screenshot with a 30-second timeout. A no-GC repeat also completed the actual-view input check and measured 339.66 MiB over its last ten samples, but its final screenshot timed out too. Both failed test outcomes remain in the raw archive; their memory data is complete, but they are not counted as fully passing profiles.

A final no-GC 20-cycle run explicitly raised and focused the window **after** sampling and before capture. It passed the entire test, including the screenshot and typed input in the actual mounted xterm. Its final-ten-sample renderer median was **301.66 MiB**, versus **432.24 MiB** for the long baseline (130.58 MiB lower). The captured image was inspected. The recorded window was visible and focused both before and after the explicit raise, so this success does not establish the precise cause of the earlier capture timeouts. There were no WebGL failures.

That final run had no slow-pan missing frames. Its first fast pan missed one frame; its 20 subsequent fast pans had eight missing frames in total, including three in one cycle. The original long run's repeated pans had none, because its larger mounted set covered those repeated paths. This is a real remaining fast-pan tradeoff, not a claim of identical frame delivery.

There is one 20-cycle baseline and three candidate long runs, two with incomplete screenshot validation. Their latter-half medians span 301.66–339.66 MiB, versus 432.24 MiB original. This supports a **roughly 90–130 MiB renderer reduction in this dense offscreen-panel workload**, rather than a fixed whole-app saving or a proven long-term bound. The eight-cycle comparison and shorter post-pan comparisons show smaller benefits.

## Decision

Keep the small overscan/preloading candidate on this isolated branch for review. It has a larger demonstrated effect than the rejected usage-worker idea, without adding workers, timers or resource-lifecycle ownership. The gain depends on offscreen disposable views; it does not reduce the cost of fully visible overview panels or loaded browser guests. Fast-pan exposure gaps, other display configurations and remote attach latency still limit generalization. No PR was created or changes merged.

## Correctness and validation

Every profile verifies all 48 PTY IDs/PIDs remain identical, live and unsuspended; ordinary typing reaches a visible job after the pan cycles. Unit coverage verifies early preloading, delayed removal of trailing nodes, mount staging, and offscreen focused/pinned/native-surface exemptions.

- 154 tests in 27 canvas/terminal test files passed.
- Typecheck, dependency checks (1,103 modules), targeted ESLint, runtime build and desktop build passed.
- 15 real Electron browser regressions passed: background actions, independent input/focus, parked screenshots, live guest persistence, pan/zoom hit testing, browser dragging and tabs.

The final no-GC long profile passed, as did the existing real-PTY lifecycle regression covering zoom, culling/remount, ordinary typing and application-cursor ArrowUp. In total, the 15 browser regressions plus that lifecycle test passed; the two historical profiler screenshot failures above remain explicitly recorded. This is local macOS evidence, not remote-latency, other-platform, long authenticated-agent or all-font rendering certification.

## Reproduction

Use Node 22, own builds, and an isolated checkout. The opt-in spec owns the round-two profile lock and cleans up only its own app and runtime. Do not build during a memory run.

```sh
npm run build:runtime
npm run build
CATE_OVERSCAN_PROFILE=1 CATE_OVERSCAN_VARIANT=candidate npx playwright test e2e/viewport-overscan-ram.spec.ts --workers=1 --output=/private/tmp/cate-overscan-candidate
# Optional repeated pans:
CATE_OVERSCAN_PROFILE=1 CATE_OVERSCAN_SOAK=1 CATE_OVERSCAN_ROUNDS=20 CATE_OVERSCAN_VARIANT=candidate-long npx playwright test e2e/viewport-overscan-ram.spec.ts --workers=1 --output=/private/tmp/cate-overscan-candidate-long
```

For the original policy restore `visibleNodes.ts` from `2b25f229`, rebuild, run with a distinct label/output directory, then restore the candidate and rebuild. The rejected quarter-only iteration uses the reduced margin with the original zero-margin pan guard; the intermediate iteration uses a 0.125-screen guard. Source changes were never made during an active memory run.

`CATE_OVERSCAN_GC_DIAGNOSTIC=1` adds **separately labelled forced-GC samples after all natural-memory comparisons**, solely to distinguish collectible garbage from live retention. Those numbers must not replace the natural footprint results. Later runs also count WebGL attempts/failures without refusing or retaining contexts. `CATE_OVERSCAN_SCREENSHOT=1` requests an optional final screenshot; the two short final-policy captures were inspected and showed readable live TUI content.

The summarizer accepts profiler output directories, preserves complete samples in `viewport-overscan-2026-11-13-raw.json.gz`, and emits a compressed JSON summary. Raw results include rejected candidates and every memory endpoint, not only favorable comparisons.
