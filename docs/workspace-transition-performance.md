# Workspace transition performance

Local baseline and final run of `e2e/workspace-transition-perf.spec.ts`: two workspaces, 18 visible panels each (8 terminals, 6 populated editors, 3 browsers, 1 T3 guest), eight warm switches.

| Metric | Before | After |
|---|---:|---:|
| Median panel readiness | 634 ms | 171 ms |
| Worst panel readiness | 1007 ms | 213 ms |
| Median second-frame boundary | 242 ms | 129 ms |
| Long tasks across eight switches | 12 | 8 |
| Longest long task | 182 ms | 104 ms |
| T3 guest recreations | 8 | 0 |

Browser guest IDs and PTY IDs survived every switch in both runs. Readiness improved by approximately 73% in this comparison. Each final switch still had a long task; this is not a claim of frame-perfect switching.

## Implemented changes

- Retain T3 guest surfaces for the two most recently visited workspaces, with immediate cleanup on panel removal and eviction beyond that bound. Keep dock visibility and detached-window ownership explicit.
- Batch incoming browser-surface measurements and retain guest dimensions while parked.
- Coalesce global terminal atlas recovery; spread optional WebGL context upgrades across frames while fallback terminal rendering remains available.
- Preserve two recent explorer trees and expansion/selection state during revalidation; start activation reads immediately.
- Prevent a stopped/replaced Git monitor from scheduling another poll after an in-flight request completes.
- Avoid resetting worktree territory canvas dimensions when they have not changed.

## What the test uncovered

A diagnostic CPU profile attributed about 109 ms of self samples to the territory layer’s `sizeActive()` during one warm switch. Setup assigned the same backing-store dimensions repeatedly. The regression test now verifies that setup allocates each dimension once, and an actual width change does not reset the height. CPU-profile timings are diagnostic and were not used for the latency comparison.

The transition counters showed that one workspace recreated six WebGL terminal renderers per return while the other recreated none. In that diagnostic run, the first workspace retained six grants while the other used fallback rendering. The final scheduled-upgrade run recorded six context creations for the first workspace and two for the second. Scheduling context creation across frames reduced the final observed longest long task to 104 ms. Grant fairness remains a separate issue.

## Remaining work

- Six Monaco editor instances are still created per switch, with 24 EditorPanel render commits in the measured window. The editor model cache preserves content, but the keyed workspace shell still recreates the editor UI. Consider bounded editor-instance retention or scheduling initialization after the first useful frame.
- Editor mounting also redefines the global Monaco theme and writes scratch content back even when unchanged. These are concrete follow-up paths to isolate with counters/profile spans; this run does not separately quantify their cost.
- The terminal GPU budget remains uneven across inactive and active workspaces. Investigate grant handoff without introducing context churn or glyph corruption.
- The explorer records two directory reads per switch despite the warm view cache. Trace request reasons and paths before treating the second read as redundant.

## Validation and limits

Build and TypeScript checks passed, as did 72 focused unit tests and six T3 E2E checks covering dock visibility, guest drafts, keyboard focus, detached windows, real conversation workspace switches, and sidebar geometry. The terminal tests and transition benchmark passed again after scheduling GPU upgrades.

T3 uses the deterministic fixture in the performance test, not production conversation history. Frame timing covers one second of settling after readiness; readiness includes automation polling latency. Focus events are simulated because E2E windows remain hidden. Other builds/live tests were observed on the machine during this session, so treat these small local samples as directional evidence, not portable latency guarantees.

Use `CATE_TRANSITION_CPU_PROFILE=1` with an HTML/JSON reporter to retain `transition.cpuprofile`. See [performance.md](performance.md) for commands and metric definitions.
