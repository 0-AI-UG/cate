# Canvas architecture experiments, 2026-11-08

Implementation follow-up: [applied fixes and updated prototype results](canvas-performance-implementation-2026-11-08.md).


All five prototypes have been measured in authorized visible foreground tests. The original application changes remain separate from these experimental branches. No prototype was merged into the main working tree.

| Method | Measured outcome | Recommendation |
| --- | --- | --- |
| Numeric geometry cache | Most DOM geometry reads removed; roughly 6–10% less renderer work in regular cases, mixed frame pacing | Possible CPU optimization; no smoothness claim |
| Semantic rendering levels | Dense zoom about 92 → 120 rAF callbacks/sec; lower CPU/RAM, but recovery up to 133 ms | Promising after smooth detail restoration |
| Terminal parse scheduler | No frame improvement; 32.9 seconds extra drain and queue cancellation under stress | Reject current global 8 KiB/frame policy |
| Retained shared GPU frames | Cold GitHub stalls shrink in two trials but remain around 242–258 ms; content age up to 500 ms | Does not solve the cold stall |
| Separate browser GPU | Cold GitHub canvas maximum around 9.4 ms versus 192–392 ms controls; roughly 200–300 MiB extra RAM | Strongest isolation direction; substantial production integration remains |

Five isolated worktrees were created from a snapshot of the existing local changes, commit `33a16b5c1724b4e6d4e7d560888565ad4a9a3949`. The original working tree was preserved. All candidates use the same runtime bundle and common input profiler. Prototype builds and focused correctness checks passed before collection.

| Experiment | Change | Main tradeoff to measure |
| --- | --- | --- |
| Geometry | Cache numeric browser surface geometry; avoid repeated DOM rectangle/style scans during viewport transforms | Cache invalidation correctness |
| Rendering levels | Use previews for small nodes; retain mounted state and persistent surfaces | Detail restoration work and retained memory |
| Terminal scheduler | Share a bounded, fair terminal parsing queue | Output throughput, queue age and recovery |
| Retained browser frames | Capture shared GPU textures in the same Electron GPU service | Capture cadence, frame age, retained textures and sandbox integration |
| Separate browser GPU | Run the browser producer in a separate Electron application | Extra process memory, JPEG transport latency and browser feature integration |

The last two experiments are standalone rendering testbeds, not complete replacements for Cate's browser panel. The separate-GPU comparison includes a same-process JPEG control to distinguish process isolation from transport changes.

## Measurement protocol

Apple M5, 16 GiB unified memory, macOS, Electron 42.11.18, DPR 2, 1400×950 window. Visible foreground measurements are collected separately from offscreen probes. Native window focus is sampled throughout; a failed focus check stops the queue. No result is called a smoothness pass merely because its collection test succeeds.

Common canvas cases include 24 mixed panels, six animated browser panels, 48 mixed panels at low zoom and detail restoration, and six terminals producing concurrent output. Pan and zoom input is generated every 16 ms independently of rendering. Each gesture lasts four seconds followed by one second of recovery, with two repeats. Terminal completion also waits for the producer completion markers and, for the scheduler, a drained parse queue.

Frame times are renderer requestAnimationFrame intervals, not measured screen presentation latency. RAM is the sum of sampled Electron process working sets, which can count shared memory multiple times. CPU figures are summed values reported by Electron. GPU-process CPU is distinct from hardware GPU utilization. Hardware GPU samples are whole-machine utilization and cannot be attributed solely to Cate. Runtime memory is not included in Electron process totals.

Browser testbeds use real GitHub home/repository navigation and a fresh application GPU-cache identity per trial. They check source visibility/activity, real browser pixels, native-coordinate clicks, capture cadence, frame freshness and bounded retained resources.

## Collection status

The interrupted November 7 foreground/background trials and initial offscreen smoke are excluded from foreground comparisons. The offscreen smoke demonstrated actual paints and correct pixels, but ran around 60 Hz and is not comparable with the approximately 120 Hz visible environment.

Raw collection directory: `output/canvas-architecture/canvas-arch-1794079816/foreground-resumed/`. Worktree and runtime hashes: `output/canvas-architecture-manifest.json`.

## Integrated canvas foreground observations

Two repeats each; these are small-sample observations, not confidence intervals. The table uses the mean of each trial's p95 and the worst observed interval across the two trials. CPU is the summed Electron-reported value; sampled working-set totals fluctuate with Chromium caches and should not be read as unique physical memory.

| Dense 48-panel workload | Baseline | Geometry cache | Rendering levels |
| --- | ---: | ---: | ---: |
| Pan p95, ms | 10.4 | 10.0 | 9.3 |
| Pan worst interval, ms | 29.7 | 38.9 | 16.2 |
| Zoom-in rAF callbacks/sec | 91.6 | 96.5 | 120.2 |
| Zoom-in p95, ms | 17.4 | 16.8 | 9.0 |
| Zoom-in CPU reported sum | 38.4% | 43.7% | 15.4% |
| Zoom-in working-set mean | 2795 MiB | 2837 MiB | 2425 MiB |
| Worst recovery interval, ms, either action | 29.9 | 39.3 | 133.4 |

Rendering levels leaves all 16 browser surfaces mounted for browser functionality, while the cold preview state has no editor or terminal views. Full details appear after zoom settles. That policy greatly reduces motion work, but the first restoration can hitch: a separate restoration trial measured 104.7 ms cold versus 13.4 ms warm. The 133.4 ms dense-case recovery is a failure of the desired smoothness target, despite the good active-gesture intervals.

Geometry caching reduces renderer work by roughly 6–10% in the regular workload and removes most geometry DOM reads. It does not consistently improve browser-heavy frame pacing: animated-browser zoom-out measured about 101 rAF callbacks/sec baseline versus 99 with caching. It is a potential CPU optimization, not evidence that the browser GPU bottleneck is solved.

## Retained shared GPU textures: valid foreground results

| Cold GitHub home, one fresh-cache trial per action | Embedded browser | Shared texture presenter |
| --- | ---: | ---: |
| Pan p99 / max, ms | 91.7 / 350.0 | 16.6 / 241.6 |
| Zoom p99 / max, ms | 91.8 / 424.9 | 16.6 / 258.3 |
| Pan CPU reported mean sum | 7.54% | 7.83% |
| Zoom CPU reported mean sum | 6.71% | 8.29% |
| Pan peak summed working sets | 782 MiB | 803 MiB |
| Zoom peak summed working sets | 812 MiB | 792 MiB |
| Browser frame age p95 / max, pan | not instrumented | 53 / 453 ms |
| Browser frame age p95 / max, zoom | not instrumented | 54 / 480 ms |

These observations show fewer/lower stalls in the retained variant, but both variants fail the 25 ms maximum interval target. With one cold trial per action, the size of the improvement is uncertain. Browser content can be stale while the canvas reuses an older frame. Both sources remain visible/focused with a 900×650 viewport. The shared fixture's observed source cadence was around 66 Hz versus 116 Hz embedded, despite requesting 120; this limits equal-workload comparisons. Real GitHub source rAF activity was around 101 shared versus 92–97 embedded, so source visibility throttling is not the explanation for that observed difference.

All eight valid rows pass pixels, native-coordinate click forwarding, source activity, native foreground checks and bounded texture retention (at most two; zero outstanding after disposal). The repository page returned insufficient content (55 characters) and was excluded rather than accepted as a cheap workload. GPU-process CPU increased in the shared variant; no attributable hardware-GPU utilization measurement was collected in this testbed. The trusted texture-import preload currently requires sandbox integration work before production use; remote content remains sandboxed.

Raw rows and summary: `foreground-resumed/frames/`. Latest prototype commit: `e347284b`.

## Separate browser GPU: valid foreground results

The matched controls use the identical JPEG quality and bounded mailbox. The isolated producer is a second Electron application with a separate GPU PID. Host and worker process metrics are combined and deduplicated by PID.

| Cold GitHub home | Worst pan / zoom interval | Peak summed working sets, pan / zoom | CPU reported mean sum, pan / zoom | Browser frame age p95, pan / zoom |
| --- | ---: | ---: | ---: | ---: |
| Embedded browser | 324.7 / 391.7 ms | 794 / 808 MiB | 4.89 / 5.22% | unavailable |
| Same-process JPEG, 15 fps | 208.4 / 241.7 ms | 853 / 854 MiB | 7.48 / 2.99% | 138 / 97 ms |
| Separate GPU JPEG, 15 fps | 9.4 / 9.4 ms | 1085 / 1077 MiB | 3.23 / 2.92% | 211 / 265 ms |
| Same-process JPEG, 60 fps | 191.6 / 216.6 ms | 895 / 889 MiB | 5.07 / 5.03% | 50 / 122 ms |
| Separate GPU JPEG, 60 fps | 9.4 / 9.4 ms | 1094 / 1092 MiB | 5.67 / 5.64% | 258 / 178 ms |

The isolated host maintained approximately 120 rAF callbacks/sec in these tests. The 60 fps source installed approximately 310–313 frames over six seconds, compared with 84 at 15 fps. This supports isolation of the parent from browser GPU stalls, beyond reducing the browser capture rate: the matched same-process JPEG controls still stalled. It does not accelerate the webpage itself; cold browser freezes and stale images remain. One cold trial per action is insufficient to claim an absolute worst-case guarantee.

Whole-machine hardware GPU utilization averaged 23.4 / 21.6% for the 60 fps same-process pan/zoom controls and 26.5 / 23.8% for isolation. At 15 fps the corresponding values were 17.4 / 16.2% and 18.6 / 16.4%. These include other applications and are contextual readings, not attributed Cate GPU percentages.

Sixteen valid cases passed real pixels, source activity, native focus, viewport size, click forwarding, bounded frame retention and cleanup. Distinct GPU PIDs were verified; all 108 sampled processes exited. Repository navigation again returned insufficient content and was excluded. Production keyboard/IME, accessibility, selection, browser lifecycle and cross-process zero-copy transport remain unimplemented. This is the strongest measured architectural direction for the cold browser GPU coupling, with an explicit roughly 200–300 MiB process-memory cost.

Raw rows: `foreground-resumed/isolation.json` and `isolation-60.json`. Latest prototype commit: `33bdd750`.

## Terminal parse scheduler

The regular workload (six terminals, 512-byte writes with 5 ms sleep) remains near 120 rAF callbacks/sec in both versions. The scheduler finishes with 20,100,617 received and parsed bytes, zero cancelled bytes and an empty queue. There is no demonstrated frame-pacing advantage.

A bounded stress workload uses six producers, 4096-byte writes with 2 ms sleep and 2500 iterations each. Both versions again stay near 120 rAF callbacks/sec; mean per-trial pan p95 is 9.9 ms baseline versus 10.1 ms scheduled, and zoom-in p95 is 9.8 versus 10.0 ms. The scheduler needs another **32.895 seconds** after gestures to finish, versus 46 ms for baseline. Total case duration is 60.4 versus 27.8 seconds. This rejects the current one-parser, 8 KiB-per-turn policy for this workload: it lowers instantaneous work by delaying output without improving canvas pacing.

Stress sampled working-set means are 770 / 799 MiB baseline pan/zoom and 811 / 835 MiB scheduled. Electron CPU means are 13.1 / 5.8% baseline and 7.0 / 5.5% scheduled, but this is not an efficiency win: the variants complete different amounts of output during those intervals. Whole-machine GPU utilization averages are 65.5 / 60.6% and 60.4 / 61.6%, respectively, without per-app attribution.

Stress scheduler accounting ends at 64,412,412 received bytes, 56,771,143 parsed, 7,641,269 cancelled, zero pending; queued jobs and in-flight parsing are zero. Maximum pending bytes are 6,510,287 and lifetime maximum queue age is 199.9 ms. Cancellation/reset semantics require care: an empty queue does not mean every received byte was parsed. Runtime completion-marker checks read the daemon's terminal history, not the client xterm buffer, so these runs do not prove the final marker was visibly painted. The regular workload has no cancellations. This prototype is not recommended for integration based on these results.

The shared-texture experiment was repeated with asynchronous whole-machine GPU telemetry. All four repeat cases passed. Embedded pan/zoom maximum intervals were 358.5 / 425.0 ms versus shared 250.7 / 250.3 ms, consistent with the first trial's partial improvement and remaining severe stalls. Whole-device GPU utilization averaged 31.3 / 28.9% embedded versus 27.6 / 24.6% shared; peak readings were 44 / 47% versus 37 / 34%. Electron CPU means were 6.15 / 7.16% versus 7.98 / 7.71%, with peak summed working sets 807 / 815 MiB versus 808 / 793 MiB. Shared frame age reached 447 / 500 ms. These whole-device GPU readings include other apps. All 28 telemetry samples had available counters. Raw repeat: `foreground-resumed/frames-gpu-repeat/`.

Scheduler cancellation analysis: the queue cancels bytes on a fresh-screen reset or binding disposal. Two groups of five cancellations with stable terminal mount counts suggest the runtime's five-second slow-viewer timeout caused reattachment and fresh snapshots; this is an inference because the counters do not distinguish reset from disposal. Canonical daemon output remains intact, but intermediate client output/history can be skipped. The reported 199.9 ms maximum measures batch-job age, not oldest pending-byte age, and can conceal seconds of byte backlog. Thus this prototype has both throughput and client-output continuity concerns.

## Coverage and decisions

Accepted integrated-canvas files: baseline regular/dense/restoration/normal-output/stress, geometry regular/dense, levels regular/dense/restoration/normal-output, scheduler normal-output/stress. These contain 78 valid foreground gesture trials. Backend testbeds add 12 retained-frame trials (including the four-case GPU repeat) and 16 GPU-isolation trials. In total, 106 foreground gesture trials form this comparison. The workloads differ by purpose; do not compare absolute RAM/CPU between the integrated multi-panel canvas and the standalone one-browser testbeds.

Focus-invalid/partial runs, startup failures, the original undersized-webview fixture and insufficient-content repository responses are excluded. No unsupported result is silently treated as a smoothness success. Foreground activation was corrected outside timing to explicitly restore regular activation and unhide the app before focusing the window; no focus restoration occurs during measured gestures. There were no concurrent experiment builds or tests during timing. Other applications can still affect whole-machine readings. The two browser testbeds now assert equal 900×650 source viewport sizes, real pixels and active source rendering. The fresh GPU identities change only temporary copies of the official engine and never delete user caches.

Recommended next development is to isolate browser GPU production while preserving the runtime/session architecture, then implement full browser input/accessibility/lifecycle integration and improve frame transport. The measured JPEG path establishes the isolation benefit; it is not a production-ready browser backend. Detail-level rendering is a separate promising optimization if cold mounting is spread across frames without a recovery hitch. Geometry caching can be considered for reducing renderer work, with further invalidation coverage. Do not integrate the current scheduler or claim the shared-texture approach eliminates cold GPU coupling.

These experiments use synthetic DOM/CDP input and rAF intervals. They do not reproduce the physical trackpad-to-app activation path or establish that the previously reported macOS return-to-Cate delay is fixed. Actual presentation latency and broad site/device coverage remain outside this experiment.
