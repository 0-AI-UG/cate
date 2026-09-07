# Performance profiling

Build both the app and its runtime daemon before collecting measurements:

```sh
npm run build:runtime
npm run build
npx playwright test e2e/perf-stress.spec.ts
```

The suite uses an isolated Electron session. Run it without other CPU-heavy
workloads. It covers terminal output, canvas movement, editor typing, background
activity, and 10/25 overlapping browser panels. Each test attaches
`performance.json` to its Playwright result. Use the HTML or JSON Playwright
reporter when retaining or comparing artifacts. Thresholds are generous local
regression guards, not a claim about performance on every machine.

For interactive investigation, run `CATE_PERF=1 npm run dev`. Toggle the overlay
with Cmd/Ctrl+Alt+P. Profiling is disabled during normal app launches.

## Reading the measurements

- **Frame times:** mean, p95, maximum and sample count cover the explicit test
  window. FPS is derived from those frame intervals. It measures the host
  renderer's animation-frame cadence, not guest-page FPS or input latency.
- **Long tasks:** tasks longer than 50 ms accumulate for the full test window.
  The overlay has its own independent window; its one-second reset cannot erase
  test measurements. Tests check observer support instead of treating an
  unsupported observer as zero work.
- **Electron CPU/memory:** `getAppMetrics` covers Electron's tracked processes.
  Peak CPU by process type sums processes within each sample before taking a
  peak. These figures do not include all shell descendants or remote machines.
- **Runtime metrics:** each connected daemon supplies its own CPU (100% means
  one core), RSS, event-loop p95/max, and actual ps/lsof process-monitor launches.
  Runtime CPU remains separate from Electron CPU; remote hosts are identified.
  The event-loop histogram uses 20 ms resolution, so a roughly 20 ms p95 is not
  itself evidence of a stall. The first sample establishes a baseline.
- **Monitor cadence:** activity/port scan rates remain meaningful on Linux,
  where `/proc` avoids subprocess launches. The background test checks scan
  cadence using simulated application focus events (E2E windows stay hidden);
  a zero spawn count alone does not prove battery efficiency.
- **IPC:** approximate payload sizes and call rates for instrumented sends.
  Terminal throughput counts incoming output, not xterm rendering completion.
- **Availability:** a daemon that cannot provide metrics reports an explicit
  error. Do not interpret missing runtime metrics as zero CPU or zero work.

`window.__catePerf` exposes `frames()`, `longTasks()`,
`longTasksSupported()`, `renderCounts()`, and `resetWindow()` in profiled builds.
`resetWindow()` clears only the test measurement window; counters remain
cumulative so callers can take differences around an action.

Useful counters include `browserGeometryFrame`, `browserGeometryRect`,
`browserGeometryStyle`, `browserGeometryMicros`, `agentMetadataPoll`,
`agentMetadataThreads`, and `explorerDirectoryRead`. Geometry reads are shared
across browser surfaces within a frame. Agent metadata is shared per harness
partition within each renderer window, with incremental thread updates.

When comparing runs, keep hardware, display refresh rate, app build, panel
counts, viewport, and workload consistent. Record cold-start and warmed-up
measurements separately. Short samples and high host-renderer FPS cannot prove
that a large browser/agent workspace has low memory use or responsive guest UIs.

## Workspace transitions

```sh
npx playwright test e2e/workspace-transition-perf.spec.ts --reporter=list,html
```

This baseline creates two real local Git workspaces with 200 files each and
18 visible panels per workspace: eight terminals, six scratch editors with
200 lines of content, three browser guests, and one T3 guest. After warming both
workspaces, it measures eight alternating switches and checks panel readiness,
browser guest identity, and PTY identity. T3 uses the deterministic `fake-t3`
server, so this does not benchmark production conversation-history rendering.

`workspace-transitions.json` contains each switch's selection-promise duration,
second animation-frame boundary, panel-ready duration, full-window frame and
long-task statistics, renderer counter deltas, and guest recreation results.
Readiness includes automation polling latency; the frame boundary is not a
presented-frame or input-to-photon measurement. Frame statistics include one
second of settling after readiness to capture delayed fit/repaint work.
`runtime-snapshots.json` contains resource samples before and after the sequence,
not per-transition CPU peaks. Focus events are simulated because test windows
remain hidden. The test is excluded when `E2E_SKIP_PERF=1`.

For a diagnostic CPU profile of the first warm switch:

```sh
CATE_TRANSITION_CPU_PROFILE=1 npx playwright test e2e/workspace-transition-perf.spec.ts --reporter=list,html
```

Open the attached `transition.cpuprofile` in Chromium DevTools' Performance/CPU
profiler. Sampling adds overhead; compare latency using runs without this flag.
The transition counters now include `editorCreate`, `terminalWebglCreate`, and
`terminalAtlasPass`. They distinguish editor reconstruction, GPU context creation,
and window-wide atlas recovery from React render counts. The test asserts that
T3 guests survive a warm return and bounds atlas recovery passes.
