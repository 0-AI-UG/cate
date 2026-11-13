# Per-workspace runtime footprint, round two — 2026-11-13

The retained experiment reduces the measured footprint of always-live runtimes without changing their lifetime or combining workspaces. In the matched active cohort, ten runtimes running one continuously emitting command each used **523.31 → 393.96 MiB macOS physical footprint** after settling: **129.36 MiB (24.7%) less**, about 12.94 MiB per workspace. Empty-runtime scaling also improved. This is an architectural loading change, with substantial limits once optional services have been used; it is not a general 25% reduction for fully warmed workspaces.

## Baseline and isolation

Work was confined to `/Users/anton/Dev/cate/.cate/worktrees/ram2-runtime-footprint`, branch `ram2-runtime-footprint`. Initial `git status --short` was empty. Only that branch was moved from `3f7f7850` to the requested **`ba6fc77832fc818ad0de59aac1e4255e34fd57ff`**, retaining PR #826's parser/browser fixes. The busy primary checkout was not changed. Its dependency directory was symlinked as authorized; cached Node/ripgrep archives were copied into this worktree's build directory. Prior `/Users/anton/Dev/cate/docs/performance` reports and baseline performance reports were read, not edited. No other coding agents were used, and nothing was pushed, merged or submitted as a PR.

All profiling and real-daemon integration commands acquired `/private/tmp/cate-ram-round2-profile.lock` with atomic `mkdir`, recorded track and owner PID, and released only their own lock in `finally`. Bounded acquisition retries lasted at most one minute. One integration attempt yielded to another track and was retried after independent work. Every run used fresh temporary HOME and projects, and stopped only its fixture daemons. Builds finished before their associated measurements. No app, real workspace, authenticated agent turn or personal device state was used.

Comparison runs used macOS 26.3 arm64 and Homebrew Node **22.23.3**. A separate extracted-tarball smoke test used its bundled Node **22.22.2** and packaged native modules. The standalone baseline bundle was saved before edits; raw data records bundle/tarball SHA-256 hashes.

## Change and attribution

The daemon still creates and registers its explicit dependency factories and every capability at startup. Agent hooks, pid presence, status, prompt queues, terminal extensions, trust, pairing and networking availability stay live. No client connections are suspended, no local/remote branching was added, and `keepRunningWhile`, paired-device availability and background-job ownership are unchanged.

`runtime.cjs` now launches a split ESM graph in `runtime-modules/`, shipped together in the runtime tarball. This keeps optional dependency source and initialization outside the initial module graph, rather than merely wrapping an import inside one CommonJS bundle. Shared chunks retain one module instance per daemon. The optional boundaries are:

- Yjs: first acquired file buffer, including restored persisted dirty buffers.
- Headless xterm and serializer: first PTY, before allocating its process.
- Agent usage accounting: first usage/rate/limits request; active agent status remains eager.
- Browser password handling and its public-suffix database: first credential operation, including agent login/signup.
- The large curated skills seed: only when a catalog request needs the offline fallback. Skill installation, bundled-skill seeding and agent execution do not require that fallback catalog.
- Native workspace watcher: first subscription. Loading it statically in ESM could precede `main`'s PTY initialization, violating the existing macOS addon exception-handling order. Native node-pty still loads first.

The production graph test rejects an eager path to the catalog, Yjs, headless xterm, password suffix database or usage service. It caught a browser barrel re-export that otherwise kept the suffix database eager; removing that unused value export was necessary for real laziness. Real production-bundle startup and packaged first-use probes supplement the graph test.

The historical 96 MiB empty-daemon RSS is not the current measured physical cost. The matched baseline's first empty daemon was **85.69 MiB Node-reported RSS, 57.33 MiB physical footprint and 17.22 MiB JS heap used**. Candidate: **59.89 / 43.26 / 13.62 MiB**, respectively. Native mappings showed PTY/watcher addons, not WebRTC, in the original empty baseline. `node-datachannel` was already lazy and was not changed.

For those first empty-daemon samples, `footprint` attributed the baseline to about 25.72 MiB app-specific tag 16, 19.80 MiB MALLOC_SMALL and 4.78 MiB MALLOC_LARGE. Candidate: 22.34 MiB tag 16, 13.88 MiB MALLOC_SMALL and no separately reported MALLOC_LARGE. This supports a mixture of deferred code/data initialization and allocator/source retention, not a claim that all savings are live JS objects or native transport allocations. Bundle sizes identify what to investigate; measured memory establishes the result.

## Measurements

MiB below are summed per-daemon macOS `phys_footprint` from `footprint -f bytes`. They are OS process accounting, not JS heap or summed RSS, and not an assertion of unique whole-machine RAM. Processes are sampled sequentially; GC, compression and allocator history affect results. No forced GC, memory-pressure command, idle-clock advancement or periodic compaction was used.

| Cohort | Baseline MiB | Candidate MiB | Reduction MiB |
| --- | ---: | ---: | ---: |
| 1 empty workspace | 57.33 | 43.26 | 14.08 |
| 5 empty workspaces | 288.28 | 216.20 | 72.08 |
| 10 empty workspaces | 530.53 | 388.05 | 142.48 |
| 1 workspace, running terminal from startup | 61.58 | 47.88 | 13.70 |
| 5 workspaces, running terminal from startup | 278.34 | 211.04 | 67.30 |
| 10 workspaces, running terminal from startup | 544.89 | 408.57 | 136.33 |
| Same 10 active workspaces, additional settle | 523.31 | 393.96 | 129.36 |

Empty results use raw runs `baseline-repeat` and `retained-candidate`. Active scaling uses independent cohorts `baseline-active` and `candidate-active`: each runtime received trust, file read, git status, real installed-agent CLI/account inspection and a 100×30 PTY running `while :; do echo round2-working; sleep 1; done` before the 1/5/10 sample. Clients remained connected. Samples settled for three seconds at each count; the final active sample followed another five seconds. Earlier processes therefore have longer lifetimes than later ones.

At the final active sample, Node RSS was **719.61 → 530.36 MiB**, JS heap used **184.01 → 153.35 MiB**, and external memory **27.87 → 38.86 MiB**. ESM source buffering increases external memory even while heap falls. RSS is especially variable: at five active workspaces it was **309.78 → 364.77 MiB**, despite lower physical footprint. Raw data includes both Node RSS and `ps` RSS where collected; neither is substituted for footprint.

An additional empty-to-active sequence measured ten active runtimes at **499.45 → 374.19 MiB**. Its earlier baseline iteration was only **393.45 MiB** after the same workload, showing that the size of the physical saving depends on GC/compression history. The 24.7% matched-cohort result is a measured outcome, not a guaranteed lower bound or an estimate for the entire Electron app.

## First use and where savings end

The matched active cohort's median latencies across ten fresh runtimes:

| Operation | Baseline ms | Candidate ms |
| --- | ---: | ---: |
| Startup to protocol hello | 151.00 | 145.77 |
| File read | 2.41 | 2.32 |
| Git status | 10.37 | 11.28 |
| Installed-agent/account inspection | 1373.02 | 1411.04 |
| First PTY spawn | 19.92 | 22.30 |

Startup in the other matched sequence was **160.98 → 187.56 ms**; this experiment does not establish a startup-latency improvement. Agent inspection executes installed CLIs in the fresh HOME; it does not run an authenticated model turn.

After the active sample, the first workspace opened a real Yjs buffer to initial sync, cancelled it, queried password suggestions, requested agent usage, requested the offline skills index, enabled same-network access and created an acknowledged pairing secret. Network fetch was deliberately made unavailable by the fixture preload, exercising the catalog/rate fallback without public-server variability. Both variants returned **950 skills**. Pairing secrets are omitted from raw results.

| First optional use, matched active cohort | Baseline ms | Candidate ms |
| --- | ---: | ---: |
| Buffer through initial sync | 4.40 | 10.67 |
| Password suggestions | 0.62 | 10.53 |
| Agent usage | 4.75 | 5.68 |
| Offline skills catalog | 5.65 | 9.85 |
| Enable network setting (request acknowledgement) | 0.62 | 0.63 |
| Create pairing secret | 1.82 | 1.81 |

Earlier candidate first-use observations reached **57.45 ms buffer, 46.22 ms passwords, 45.84 ms usage and 25.81 ms catalog**. The extracted tarball's cold password call took **171.28 ms**; its buffer took 7.13 ms and catalog 10.92 ms. These costs move to first use; they are not eliminated. The network-setting latency is not a measurement of remote-connect completion. Secure pairing and reconnect behavior are tested separately.

After all optional first uses, that first daemon measured **53.10 → 47.69 MiB footprint**, versus the much larger active-cohort advantage. Heap used was **19.54 → 19.77 MiB**, external **2.76 → 4.02 MiB**, and RSS **66.48 → 70.05 MiB**. There is no heap/RSS win in that fully warmed sample. Both variants now retain the optional implementations; remaining footprint differences include allocator/age history and should not be promised as permanent savings. Closing a buffer or terminal does not unload its module. Workspaces that use every feature should expect most architectural savings to disappear.

## Failed directions and setup corrections

- CJS-only lazy Yjs/xterm imports did not demonstrate a useful memory reduction; the source remained inside every daemon's bundle. That approach was superseded by actual split output.
- Lazy `ws`/Bonjour initialization was tried, including an intermediate split build without the skills boundary. It did not provide convincing incremental savings and a `require` variant bypassed Vitest's WebSocket mocks. Those network source changes were reverted. Native WebRTC was already absent at startup, so pretending to newly defer it was rejected.
- The split build without the catalog boundary still eagerly carried its largest data input. The catalog boundary improved empty footprint, but the early active sequence lost most of that advantage. Investigation then moved to password-service instantiation and its suffix database; the retained result includes both and native watcher deferral.
- A sandboxed initial daemon could not bind its local socket. Subsequent real-daemon commands ran with the required socket permissions and the same isolation/lock rules.
- The initial baseline harness waited for a document file that an untouched workspace need not write. Its ~10.7-second readiness values are invalid. It is retained as diagnostic data only; matched runs wait for a protocol hello.
- A native integration assertion incorrectly expected a missing executable to reject synchronously. macOS' helper instead starts and reports a child exit. The assertion was corrected, the one leftover fixture daemon was identified by its exact test bundle and terminated, and `finally` cleanup was added. The corrected test passed. This is not claimed as a direct test of every C++ exception path.
- A stale static ordering test expected a watcher `require`; it now checks the actual production ESM output and dynamic watcher import. No failed optimization or test expectation remains in production code.

## Validation and reproduction

Passed: runtime build; complete host runtime tarball build; extracted-tarball smoke with bundled Node and natives; **153 unit tests across 13 files** (buffer persistence/conflicts, watcher behavior, skills fallback, terminal service, agent status/usage, browser credentials/login, lifetime and production graph/order); **37 real-daemon integration tests across 8 files**, including secure LAN pairing/revocation, local/machine/network parity, reconnect, trust, editor synchronization/restoration and production-bundle start/reuse/native PTY; TypeScript; targeted ESLint; dependency rules (**1102 modules, 4497 dependencies**); JS syntax checks and `git diff --check`.

The real-daemon suite passed seven files/36 tests together, then the corrected production-bundle test passed separately. The graph/order tests were rerun after correcting the static expectation. No release build, Linux/Windows execution, real TURN relay, authenticated agent turns, Electron UI profiling, long transcript churn or hours-long soak is claimed.

Build outside the profiling lock. The checked-in profile, preload and lock runner are named `runtime-footprint-round2-2026-11-13-*` alongside this report. Capture a baseline bundle from a clean `ba6fc778` isolated worktree before applying changes, using the same dependency tree and Node. Then, in the experiment worktree:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:runtime
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run runtime:tarball
python3 docs/performance/runtime-footprint-round2-2026-11-13-profile.py candidate "$PWD/dist-runtime/runtime.cjs" /private/tmp/runtime-candidate.json
python3 docs/performance/runtime-footprint-round2-2026-11-13-profile.py candidate-active "$PWD/dist-runtime/runtime.cjs" /private/tmp/runtime-candidate-active.json --active
```

`RAM2_NODE` overrides the Node binary; `RAM2_WORKSPACES=1` supports a packaged smoke. The profile acquires the shared lock itself. Wrap real-daemon integration commands in the adjacent `-lock.py` runner. Its `finally` waits for fixture cleanup before releasing its owned lock. The preload records memory via a signal and requests expensive native mapping reports only after measurement. The raw JSON includes earlier diagnostic trials, matched runs, active scaling, packaged smoke, full tool output, per-PID memory, latencies and artifact hashes. Do not pool diagnostic/invalid-readiness trials with the retained comparisons.
