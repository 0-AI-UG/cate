# Cate operation benchmarks, 2026-11-06

Measured locally on macOS arm64 with isolated Electron HOME/device profiles, built desktop and runtime, one Playwright worker. No inference requests or real agent logins. Existing untracked memory-audit fixtures were reused. Results are local samples, not portable performance guarantees. Raw logs and the serialization workload are in `output/performance/`.

## Results

| Workload | Before | After | Interpretation |
| --- | --- | --- | --- |
| First action-bar Codex launch | 23,602 ms | 4,755–12,662 ms across three runs | 46–80% lower; substantial host/probe variability remains |
| Subsequent action-bar launches | 978–1,006 ms | 1,334–1,381 ms | No demonstrated warm-path improvement |
| Serialize terminal with 100,000 history lines, 12 repetitions | median 219.5 ms, 4,888,890 bytes | median 8.94 ms, 246,421 bytes | About 24.5× faster serialization and 95% smaller payload; component benchmark, not end-to-end reattachment |
| Pan, six terminals, 150 viewport frames | 120 FPS, p95 9.2 ms | 120 FPS, p95 9.0 ms | No meaningful change |
| Mixed canvas zoom, 101 nodes | p95 16.7 ms; no long tasks | p95 16.7 ms; no long tasks | No demonstrated change |
| Warm workspace switching, 34 mixed panels across two workspaces | 160–198 ms readiness | 162–191 ms readiness | No demonstrated improvement; guests preserved in both runs |
| First / warm editor creation | 250 / 36 ms | 239 / 34 ms | Small single-run differences, insufficient evidence of improvement |
| Terminal view and PTY readiness in creation suite | 65 ms | 62 ms | No demonstrated improvement |
| Browser creation | 114 ms | 113 ms | No meaningful change |

Ten fresh terminal startup cycles measured view mount, PTY existence, and execution of a split-marker printf (so command echo cannot satisfy readiness). Initial PTY times were 20–88 ms and shell response checks 26–126 ms. Final keyboard-close cycles had PTY readiness around 23–59 ms after the first and shell checks around 35–145 ms. These include test polling overhead; no multi-second ordinary shell startup was reproduced. Temporary clean profiles do not reproduce a user's shell plugins or global startup files.

Final ten keyboard-close cycles completed at approximately 282–290 ms, including Playwright keyboard dispatch and DOM disappearance checks. This measures the client close path, not completion of runtime resource teardown. The RAM lifecycle scenario separately checks post-removal memory. No deletion optimization or speedup is claimed.

## Changes

- Optional Codex app-server account metadata now loads in the background. Native login status still determines readiness. Late results are ignored after disposal or cache replacement. Previously a nonresponsive account probe blocked readiness for its 20-second timeout.
- Terminal views request only the scrollback they actually retain (5,000 lines), reducing serialization, transfer, and parsing on reattachment. Runtime history is unchanged.
- Hook workspace preparation skips folder probes for agents with no project files, and skips readiness probes before removing disabled hooks.

The action-bar test uses an executable stand-in for Codex that answers version/login probes and deliberately does not answer the optional account protocol. It launches through the real toolbar flyout and placement picker. Version/account probes are excluded from its launch log. It verifies actual process launch, not the real Codex TUI's login, network, or inference readiness. The corrected stand-in also passes the existing start, detach, and runtime-restart lifecycle tests.

First launch still sometimes takes multiple seconds: availability waits for other installed CLIs' version/login probes, each of which can time out. This remains an improvement opportunity; changing readiness publication deserves separate lifecycle tests.

## RAM

Current lifecycle run: medians of five samples, 500 ms apart after 2.5 seconds settling. Sequential workload, no forced GC. Aggregate RSS includes Electron, detached runtimes, and terminal descendants; shared pages are counted multiple times, so this is not unique physical memory.

| Stage | Aggregate RSS MiB |
| --- | ---: |
| Shell only | 453 |
| Empty workspace and canvas | 581 |
| One terminal | 632 |
| Ten terminals | 649 |
| Ten terminals after output history | 807 |
| After closing terminals | 708 |
| One 4,000-line editor | 785 |
| Five editors | 825 |
| After closing editors | 825 |
| One tiny local browser | 894 |
| Five browsers | 1,128 |
| After closing browsers | 691 |
| Two workspaces | 780 |
| After another 20 seconds idle | 782 |

Raw samples: `output/performance/memory-after.json`. Closing browsers releases a substantial amount of resident memory; editor closure does not immediately return RSS. That alone does not establish a leak. Browser pages are tiny and agent inference workloads are excluded. Baseline RAM samples from this session were not retained before Playwright replaced its output directory, so no causal overall RAM improvement is claimed. Earlier independent RAM audits remain in this folder; their different runs are not a controlled before/after comparison.

## Validation

- TypeScript check and dependency-layer check passed.
- Targeted ESLint passed.
- 103 unit tests passed, one skipped across terminal, terminal view, agent hooks, and agent setup.
- Original operation baseline: five tests passed.
- Rebuilt operation/RAM suite: non-agent workloads passed. Three initial agent lifecycle failures occurred while the stand-in incorrectly logged account-probe launches; after correcting the stand-in, all four agent lifecycle tests passed.
- Final pan, terminal startup/close, and action-bar tests: three passed.

The terminal history component comparison demonstrates a specific optimization. Other small timing/RSS differences are not evidence of a general application speedup. More repetitions and a real user profile are needed to characterize intermittent ordinary-terminal startup delays.

The final action-bar regression assertion (each launch below 20 seconds) passed: 4,755 ms cold, then 1,324 and 1,364 ms.

## Workspace client-state cleanup follow-up

Editor sidebar presentation, applied reveal markers, and saved file trees now live in the existing workspace client-state store instead of three process-global maps. The store retains all live panels and at most 200 removed-panel view entries for undo/remount convenience, including late unmount saves. Workspace disconnect releases the store. Document subscriptions only recalculate membership when the panel-record map changes. No runtime resource lifecycle changes were introduced.

A stress test verifies that 1,000 removed entries reduce to 200 while live panels survive and recent removed state remains available. This bounds retention; it does not guarantee view-state retention for every possible undo operation (an undo can remove many panels). Dirty buffers and persisted session data are untouched.

Rebuilt Electron lifecycle and mixed-workspace transition tests both passed, and browser guests were preserved. RSS medians were 453 MiB shell-only, 580 MiB empty workspace, 940 MiB with five editors, 914 MiB after editor closure, and 880 MiB after browser closure. These sequential samples vary substantially from the previous run; they do not demonstrate a general RAM reduction. Raw data: `output/performance/memory-cache-cleanup.json`; log: `output/performance/cache-cleanup.log`.

Background terminal/editor views already unmount on workspace switches; persistent native surfaces remain available to background automation. No additional background-view suspension was warranted. Canvas margins and browser suspension were left unchanged: no measured benefit justified remount churn, page reloads, or a new activity/lease lifecycle.
