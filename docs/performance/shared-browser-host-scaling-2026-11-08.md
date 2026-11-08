Prototype source worktree: `/Users/anton/Dev/cate/.cate/worktrees/canvas-followup-1794134338/isolation`. Commands below run there.

# Shared browser-host GPU scaling experiment

This standalone testbed explores one separate Electron browser host per workspace, containing N sandboxed browser producers sharing one GPU service. It does not modify production Cate, runtime/session ownership or browser integration. The matched control puts all N producers in the canvas Electron app, using exactly the same CPU/JPEG75 transport and 60 fps source cap.

Each producer renders 900 × 650 CSS pixels at device DPR. The 1400 × 950 foreground host tiles every retained image into the visible canvas, scaling only presentation to fit. All N pages remain actively painting: one navigates to the real GitHub homepage during a five-second pan or zoom anchored to the HTTP200 main-frame response, while the others run the animated green counter fixture. Motion updates at 16 ms independently of the host rAF collector, with one second of recovery. Thus N changes the amount of captured/encoded source content while total displayed canvas area stays bounded; this is deliberately a fully visible panel workload, not full-size overlapping panels or culling.

Transport retains at most one encoded in-flight and one replaceable unencoded latest frame per source. ACK follows host image decode and installation. Total source mailbox occupancy is bounded by 2N, not an unbounded IPC queue. The canvas keeps each previous image until a replacement decodes. The main-frame response is held until the canvas starts its collector and motion and acknowledges release (bounded five-second handshake). Thirty-second response and eight-second inspection deadlines fail rather than silently waiting. Generation-tagged remote frames must install during the active input interval; navigation/response/release/commit/source-paint/install timestamps are recorded. Source inspection uses bounded CDP Runtime.evaluate instead of waiting for all late resources to finish. Source GPU stalls can freeze browser content, but canvas motion never waits for source completion. JPEG readback, compression, base64 IPC and host image decoding remain real costs.

The harness verifies every visible tile's actual initial green pixels, forwarded click, source viewport, visible/focused document state and continuing frame updates. After navigation it requires nontrivial GitHub document content and replacement host pixels; other tiles must retain correct pixels and advancing counters. It records source renderer PIDs, asserts exactly one GPU process for all producers, and asserts a second distinct host GPU only in isolated mode. Native host focus must remain true throughout sampling. All sources use Cate-like CDP focus emulation without enabling Node integration or disabling the sandbox.

Resources combine host and worker `app.getAppMetrics()` by deduplicated PID. Reports include peak process working sets (not physical memory allocation or PSS), GPU working sets/counts, summed sampled CPU percentages, raw whole-device AGX performance counters, source cadence/age, rAF frame times, startup and cleanup. Producer telemetry may lag by up to one second; CPU first samples include startup work. Paint-to-consumption age starts before JPEG encoding at the source paint callback, excluding GPU latency before that callback; held-frame age observed on the canvas captures subsequent source freezes. The test saves raw measurements before final validity assertions and fails rather than counting blank/stale pages as a success. Foreground host rAF timing is not native compositor presentation timing.

```sh
node --test e2e/fixtures/browser-isolation/latest-frame.test.cjs
CATE_ARCH_OFFSCREEN=0 CATE_ISOLATION_PROFILE=1 \
  CATE_ISOLATION_COUNTS=1,4,8 \
  CATE_ISOLATION_OUTPUT=/absolute/path/shared-browser-host.json \
  npx playwright test --config playwright.browser-host.config.ts --max-failures=1
```

To resume after a network failure, rerun the same output command with `CATE_ISOLATION_RESUME=1`: valid cases from the same response-release protocol, source rate and case key are skipped, while failed attempts remain available for diagnosis. Failures are never silently retried within a run. Optional counts include 12; modes are `same-process,isolated`; actions are `pan,zoom`. `CATE_ISOLATION_FRAME_RATE` defaults to 60. Launch only in the root coordinator's serialized GUI slot with other builds and measurements quiet. Fresh cold-cache Electron copies and disposable userData directories isolate each case from user profiles. Worker shutdown is awaited and every sampled process PID must exit before the next case.

Production integration still needs session lifecycle, keyboard/IME, accessibility, popups, downloads, resize and automation support. A prototype memory slope can justify further work but cannot establish that a production workspace host is ready to ship. Cross-process zero-copy textures are not implemented.

## Results: shared host amortizes its process cost

The completed scaling run uses **fixture-only, pan-only, 60 fps** sources and an explicit memory policy (`CATE_ISOLATION_WORKLOAD=fixture CATE_ISOLATION_MEMORY_ONLY=1`). Every tile passed initial/final pixels, forwarded-click completion, source viewport 900 × 650, visibility/focus emulation, advancing counters, bounded mailboxes and process cleanup. One separate browser host served all N producers; GPU-process count stayed two total at N=1,4,8, versus one in the matched control. No per-panel Electron browser app was created.

| Active pages | Control peak process working sets | Shared isolated host peak process working sets | Difference | Control / isolated CPU cores observed | Isolated source age p95 | Isolated installed frames/source over 6 s |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 692 MiB | 848 MiB | +156 MiB | 0.43 / 0.50 | 16 ms | 360 |
| 4 | 1077 MiB | 1274 MiB | +198 MiB | 0.86 / 0.84 | 12–16 ms | 360–361 |
| 8 | 1692 MiB | 1696 MiB | +4 MiB | 1.52 / 1.62 | 13–19 ms | 359–361 |

The N=1→8 endpoint increment is about 143 MiB/page in the control and 121 MiB/page with the shared isolated host. Adjacent increments vary substantially: control 128 then154 MiB/page; isolation142 then106 MiB/page. These are single-run working-set observations, not a precise memory model. Summing deduplicated process PIDs still counts shared physical pages in multiple process working sets; it is not physical RAM/PSS. N=8's near-zero difference must **not** be interpreted as a free extra GPU service: the control's Browser process reached ~549 MiB, while the isolated host and worker Browser processes summed to ~470 MiB; renderer/GPU working sets differed too. Heap/GC/readback allocations and resident-page accounting vary. The process topology amortizes one browser-host GPU service across pages, but these observations do not establish a stable memory slope or a production RAM budget. N=1/4 show a provisional ~150–200 MiB peak cost; repetitions and physical-memory measurements are needed before a production RAM promise.

CPU uses cumulative CPU-time deltas per PID with each host/worker telemetry timestamp, rather than repeatedly sampled `percentCPUUsage` intervals. The table sums core equivalents over each PID's observed time span. Worker telemetry covered 83–100% of the six-second interval (N=8:91%); full-window normalized core-second estimates and individual coverage are also retained. Approximately one-second boundaries are interpolated. This is a diagnostic estimate, not evidence of an energy or CPU win.

Raw whole-device GPU utilization means were control34/40/44% versus isolation27/32/35%, with maxima51/41/64% versus29/34/46%. These include other applications, and native focus was lost in several cases. They do not establish an attributable GPU saving. Native focus is recorded separately: only controlN4 and isolatedN1/N4 retained it throughout. Other rows have `performanceValid=false`; their rAF results must not support a foreground smoothness claim. `validForMemory=true` requires all source/resource checks and verified process exit despite native focus loss.

Startup to initial active images took ~2.1–2.3 seconds in the control, ~3.7–3.9 seconds with the separate host. Isolated cleanup completed in151/180/3169ms. N=1/4 completed promptly; N=8 is near the existing three-second worker kill fallback. Historical telemetry recorded worker exit but not its signal, so N=8 graceful disposal is unknown and explicitly labelled as a possible forced worker exit. The harness now records worker fallback and exit signal, separately from host fallback. ControlN1 exited gracefully in148ms; controlN4 hung during Electron source destruction and required manual task-process-group termination after182s, and controlN8 required the new bounded fallback after5.13s. Both are explicitly marked `forcedCleanup=true`, not graceful success. The harness now stops painting, detaches source debuggers and releases queued bitmap references before destruction, limits shutdown and close to five seconds each, and kills only its disposable task process group if necessary. All59 unique sampled PIDs were verified absent after the matrix. Native multi-OSR teardown remains a prototype concern.

## Real GitHub cold-load proof is separate

Public-network waits prevented a valid multi-page GitHub matrix; failed attempts record no response headers or committed navigation within the30s deadline. They are excluded. A strict N=1 response-anchored proof succeeded independently in both modes. The HTTP200 headers were held until host motion/collector initialization acknowledged release. In the control the new GitHub generation first painted at+483ms and installed at+484ms during the active five seconds; host maximum frame time was275ms. In isolation the source first painted at+487ms and installed at+489ms during the active five seconds; host maximum was9.4ms. Both verified actual GitHub pixels and content, 900 × 650 source viewport, native host focus and separate GPU ownership. This validates the single-source cold-stall isolation direction; it **does not** validate GitHub cold loads with four/eight pages. Browser content still freezes: isolated source frame-age p95 was221ms during this cold-load proof.

Raw artifacts in the root checkout: `output/canvas-followup/canvas-followup-1794134338/shared-browser-host-memory.json`, `shared-browser-host-proof.json`, `shared-browser-host-isolated-proof.json`, with screenshots beside them. Failed network/setup attempts remain in the other JSON outputs. No prototype code has been merged into production Cate.

The measured-interval mean/minimum/peak working-set totals provide additional context:

| Pages | Control mean / minimum / peak | Isolated mean / minimum / peak | Processes control / isolated |
| --- | --- | --- | --- |
| 1 | 620 / 551 / 692 MiB | 830 / 805 / 848 MiB | 5 / 8 |
| 4 | 982 / 908 / 1077 MiB | 1205 / 1139 / 1274 MiB | 8 / 11 |
| 8 | 1494 / 1369 / 1692 MiB | 1558 / 1421 / 1696 MiB | 12 / 15 |

At N=8, the control's mean Browser/GPU/Utility/host-renderer/source-renderers buckets were325/223/45/156/745MiB. Isolation's host Browser143 + worker Browser243, host GPU102 + worker GPU152, utilities39+40, host renderer149 and source renderers689MiB summed to1558MiB. Eight distinct source renderer PIDs were verified in both modes. Lower resident source working sets and different Browser-process heap peaks offset part of the extra process footprint in this particular run. Each tile's correctness check also captures the whole host screenshot; eight such readbacks could affect allocator pools differently when one or two GPU services own them, but that attribution has not been established. The saved `shared-browser-host-memory-summary.json` contains the full bucket breakdown.

Reproduce the finite memory matrix without public-network waits:

```sh
CATE_ARCH_OFFSCREEN=0 CATE_ISOLATION_PROFILE=1 \
  CATE_ISOLATION_WORKLOAD=fixture CATE_ISOLATION_MEMORY_ONLY=1 \
  CATE_ISOLATION_COUNTS=1,4,8 CATE_ISOLATION_ACTIONS=pan \
  CATE_ISOLATION_OUTPUT=/absolute/path/shared-browser-host-memory.json \
  npx playwright test --config playwright.browser-host.config.ts --max-failures=1
```

Memory-only mode keeps native visibility and source work unchanged but logs native focus instead of rejecting RAM data when another app becomes active. All pixel, input-completion, viewport, source-update, GPU ownership and bounded-mailbox checks remain mandatory. Rows become `validForMemory` only after every sampled process exits, and forced disposal is explicitly reported. Production integration remains unjustified until repeated resource measurements and reliable multi-OSR disposal are established.
