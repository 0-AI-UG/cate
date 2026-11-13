# Terminal parser RAM experiment — 2026-11-13

Retain one change: split terminal binding writes into at most 16,384 UTF-16 code units (strings) or bytes (Uint8Array). In the matching 20-view experiment this removes **8.75 MiB of retained backing storage**, with comparable attach, output and remount latency. History, running jobs, runtime screens and the existing WebGL budget are unchanged.

Baseline: committed `3f7f7850137f57f97c2a14f2ee0d51a613da365e`. Branch/worktree: `ram-terminals`, `/Users/anton/Dev/cate/.cate/worktrees/ram-terminals`. The worktree started clean at that commit; primary-checkout edits were not copied or modified. Existing scrollback-default and WebGL-budget optimizations were read and retained.

## Why this allocation

xterm 5.5's InputHandler retains a UTF-32 parser scratch array that grows to the largest write, capped at 131,072 elements. Cate supplies an entire serialized history in one binding write on attach. The fixed history snapshot here is 198,842 code units: each view consequently retains a 512 KiB scratch array even after parsing finishes. Splitting both snapshots and subsequent output through public `terminal.write` keeps the array at 64 KiB. This uses no private xterm fields in production, changes no transport windows, and acknowledges each byte event only after its last chunk parses. Zero-length writes retain their callback behavior.

Runtime investigation: HeadlessScreen owns the authoritative grid/history, pending strings until parsing callbacks, and serialization. It also has the scratch allocation (512 KiB for this synthetic bulk write), but no runtime allocation or process policy was changed. TerminalService still owns PTYs, logging and bounded flow control. The client continues to parse its full configured history. Runtime history paging/compression would be a separate, larger behavioral change.

Inactive terminal dock tabs already unmount (`DockTabStack`/`keepsMounted`); viewport culling already disposes ordinary offscreen views. Focused, pinned and native-surface-containing nodes can be exempt. Merely setting binding visibility false does not detach its stream. No duplicate culling policy or SIGSTOP-based RAM claim was added.

## Matching measurements

Apple M5, 16 GiB, macOS arm64 (Darwin 25.3.0), Electron 42.11.16, xterm 5.5.0. Profiling runner/temporary workload Node was 26.9.0; final unit/type/dependency checks used installed Node 22. The profiling Node is outside package.json's declared Node range, a portability limitation.

Each run launches a fresh temporary HOME/device profile and a shown 1400 × 950 window at DPR 2. The harness bundles Cate's actual xterm factory and binding, with a deterministic transport stand-in. It generates a real HeadlessScreen snapshot from 10,000 colored agent-like lines containing paths, JSON and Unicode. Twenty overlapping views use a fixed 120 × 30 grid and the existing 2,000-line setting; the existing two-view WebGL budget remains enabled. After attach, each receives the same 64,000-code-unit tail as UTF-8 streaming output. It then scrolls all views for 120 frames, disposes them as culling does, and remounts from the original snapshot.

CDP explicit GC is diagnostic only, before retained-memory samples after a one-second settle. `vmmap -summary` supplies process physical footprint. The final comparison uses three clean candidate launches followed by three committed-binding confirmation launches, without overlapping builds. Baseline binding source is loaded explicitly from the above commit by the harness; the empty app shell is the same settled build and does not mount production terminal panels in this comparison.

Medians of three launches:

| Metric | Baseline confirmation | Retained 16 KiB writes |
| --- | ---: | ---: |
| Scratch backing per view | 512 KiB | 64 KiB |
| Scratch backing, 20 views | 10.00 MiB | 1.25 MiB |
| Total renderer backing storage after live output | 69.11 MiB | 60.36 MiB |
| Cell backing, 20 views | 55.76 MiB | 55.76 MiB |
| Renderer physical footprint after live output | 174.0 MiB | 165.3 MiB |
| Initial attach/parse, 20 views | 127.3 ms | 128.1 ms |
| Live batch parse/ack, 20 views | 11.4 ms | 11.7 ms |
| Remount/parse, 20 views | 114.0 ms | 113.4 ms |
| Scroll frame interval p95 | 33.9 ms | 33.5 ms |

The exact 8.75 MiB backing difference matches the scratch arrays. The 8.7 MiB footprint reduction (5%) supports that allocation result but is not a guaranteed whole-system saving. JS heap remains about 18 MiB. Both variants retain 2,030 rows per view with identical first/last text, and dispose back to about 2.28 MiB backing storage. No additional offscreen saving is claimed. GPU footprints vary widely; no GPU saving is claimed. Memory columns overlap and must not be added.

The first three baseline launches were slower (143.7 ms attach, 15.9 ms live, 117.1 ms remount), which motivated the confirmation run. The retained change trades more write queue entries and parser calls for smaller retained scratch buffers. The final sample shows small latency differences, not a throughput improvement. Twenty simultaneous scroll operations are deliberately demanding (~30 Hz here); this is not a promise of smoothness under arbitrary agent/TUI loads.

## Real runtime and correctness

A separate candidate-only isolated Electron scenario starts twelve real PTYs. Each Node job prints 10,000 lines, then continues heartbeats every 200 ms. Idle suspension is disabled in that temporary workspace. All twelve views cull to zero xterms/canvases; output continues, history remains, and remount restores twelve views with the same PTY IDs/PIDs, alive and unsuspended. Observed remount-to-visible-heartbeat time was 200 ms. The normal custom-scrollback test also passes for 2,000, 5,000 and 500 configured lines and view remounts.

Candidate-only physical footprint, visible / culled / remounted: renderer 269.3 / 271.1 / 283.6 MiB; runtime 220.3 / 220.5 / 221.4 MiB; GPU 710.4 / 426.5 / 649.4 MiB. These sequential, unforced-GC samples verify lifecycle behavior; they are not baseline/candidate savings. The background jobs are lightweight stand-ins, not authenticated agent CLIs. Jobs run until isolated-fixture teardown; production processes/workspaces are untouched.

Passed: desktop/runtime builds; 144 tests across 21 terminal service/view files under Node 22; typecheck; dependency checks; targeted ESLint; both real-PTY lifecycle and existing custom-scrollback Electron checks. New unit coverage compares serialization including Unicode, attributes, alternate buffer/modes across chunk boundaries and verifies final-chunk byte acknowledgements. No live job pausing, history reduction, process policy or renderer-resource policy was introduced.

## Failed/rejected attempts and limits

- 4 KiB writes saved 9.69 MiB but had worse/noisier timings: median attach 361.8 ms, live 51.2 ms, remount 151.1 ms, scroll p95 53.1 ms. Rejected; 16 KiB keeps most savings with fewer writes. The shared host was not otherwise quiescent, so timings do not prove all that slowdown came from chunk size.
- First sandboxed Electron launches aborted. Profiling required execution outside the sandbox. Stale locks from those failed workers were removed only after checking those owned workers exited.
- Initial real-PTY harness failures were incorrect shell quoting and using a client workspace ID instead of the runtime data-directory ID. Corrected; no results from those attempts are used.
- An initial 16 KiB run overlapped this experiment's rebuild and its third launch timed out. Its two partial samples are preserved separately and excluded. All builds were finished before the final comparison. Process inspection found no orphan from the interrupted launch.
- `vmmap` warned that PartitionAlloc malloc-zone inspection was incomplete in early runs. Physical-footprint summaries and CDP backing counts are reported, without attributing malloc regions.
- Short repeated runs, allocator/compositor caches, overlapping panes, fixed width/font, no sustained real-agent soak, no other clients/mobile or cross-platform measurements. No memory-pressure or unique physical RAM claim. Savings depend on sufficiently large writes and disappear when a view is disposed.

## Reproduce

Raw data: [terminal-ram-2026-11-13-parser-raw.json.gz](terminal-ram-2026-11-13-parser-raw.json.gz). Keys preserve the initial baseline, rejected 4 KiB run, incomplete rebuild-overlap run, final 16 KiB run, baseline confirmation, real-PTY lifecycle and environment. Early `runtimeStats.memory` is test-runner memory, not daemon memory; it is unused in conclusions.

```sh
# In this isolated worktree; node_modules may symlink to the primary checkout.
npm run build
npm run build:runtime
# Run sequentially, after builds finish. Each profile acquires the shared lock.
CATE_TERMINAL_RAM=1 CATE_RAM_VARIANT=baseline npx playwright test e2e/terminal-ram-2026-11-13.spec.ts -g bounded-write --workers=1 --output=/private/tmp/cate-terminal-ram-baseline-confirm
CATE_TERMINAL_RAM=1 CATE_RAM_VARIANT=chunk16384 npx playwright test e2e/terminal-ram-2026-11-13.spec.ts -g bounded-write --workers=1 --output=/private/tmp/cate-terminal-ram-chunk16384-settled
CATE_TERMINAL_RAM_LIVE=1 CATE_RAM_VARIANT=chunk16384 npx playwright test e2e/terminal-ram-2026-11-13.spec.ts e2e/terminal-scrollback.spec.ts --workers=1 --output=/private/tmp/cate-terminal-ram-live-chunk16384
npx vitest run src/services/terminal src/shells/desktop/ui/panels/terminal
npm run typecheck
npm run lint:deps
npx eslint src/services/terminal/client/binding.ts src/services/terminal/client/binding.test.ts e2e/terminal-ram-2026-11-13.spec.ts
```

To repeat the rejected iteration, temporarily set `WRITE_CHUNK_SIZE` to 4096 and use a distinct output directory. Restore 16 KiB afterward. Resource-intensive profiles serialize via atomic `mkdir /private/tmp/cate-ram-profile-20261113.lock`, write track/PID ownership, wait at most 60 one-second retries, and release in `finally` only when the owner matches. Lock contention from the browser experiment was observed; its lock was respected. Build/unit-check commands do not acquire that lock. `build:runtime` regenerates version.ts from package.json; its incidental source change was restored before committing. Nothing was pushed or merged.
