# Terminal history RAM experiment, round two — 2026-11-13

Retain the experiment: desktop terminal views follow live output with a **128-row history cache**, then hydrate the configured runtime history on upward scrolling, search or macOS Select All. This is a client cache budget, not a lower retention setting. The runtime still retains the configured history (2,000 rows by default; existing custom limits remain supported).

At 20 panels, median renderer footprint falls **228.20 → 153.60 MiB** (−74.60 MiB, 32.7%). At 50 panels it falls **450.50 → 256.50 MiB** (−194.00 MiB, 43.1%). Actual retained client cell arrays fall **92.4%** at both scales: 40.02 → 3.04 MiB and 99.84 → 7.59 MiB.

**Workload scope:** these substantial savings are conditional on filled normal-buffer history. The actual Codex agents in this workspace report `alt=true`. **Alternate-screen TUIs with an empty normal buffer have little or no history saving from this experiment**: their screen cells still need storage, and there is no large normal history to deduplicate. Alternate-screen mode alone does not establish whether older normal-buffer history exists. A separate focused renderer experiment is measuring that workload; it was not profiled again here. These log-heavy results must not be presented as measured savings for those Codex TUIs.

**Selection-only follow-up:** all memory/latency tables below measure commit `6f86f42a`, before the final full-selection safeguard. The follow-up captures the complete selected text at the reset barrier, verifies `terminal.getSelection()` after restoring a candidate range, and clears an unverifiable selection. A repeated-start-line regression covers unseen output shifting the original multi-line block while another block shares its first line. Valid selections remain intact. This changes selection verification only, not the production history allocation path; bulk memory profiles were not repeated, as requested. Measured source hashes in the raw file intentionally remain those of the pre-fix experiment.

These are actual Cate renderer/process measurements with running PTYs, not parser-only projections. They establish reduced renderer allocation and footprint; they do **not** establish a fixed whole-process-tree physical RAM saving. Runtime/GPU memory remains substantial and variable.

## Isolation and architecture

Worktree/branch: `/Users/anton/Dev/cate/.cate/worktrees/ram2-terminal-history`, `ram2-terminal-history`. The worktree started clean at `3f7f7850137f57f97c2a14f2ee0d51a613da365e`; status was checked before moving only this experiment branch to requested baseline `ba6fc77832fc818ad0de59aac1e4255e34fd57ff` (PR #826). No primary-checkout source was changed or copied into the experiment. Historical performance reports were read in the primary checkout. Its node_modules was symlinked as permitted, without installing or patching dependencies. App/runtime build outputs stayed in this worktree. No agents were spawned.

The runtime's existing headless screen is authoritative. Its `process.attach` already accepts a scrollback limit and synchronously orders serialized state, pending runtime writes and later output. The desktop now uses that boundary for lazy hydration, without changing the wire protocol or branching on transport.

- A new/remounted view keeps `min(128, configured history)` rows above the screen and attaches with that limit. Several screens of local history keep ordinary scrolling available immediately.
- Native viewport scrolling (wheel/scrollbar) and xterm's public scroll API both trigger hydration in the normal buffer. xterm suppresses its public event for native scrolling, so both subscriptions are necessary. Search awaits parsing before finding matches; stale query completions are ignored. Cmd+A hydrates before selecting the entire buffer, while search-input selection remains native.
- Hydration replaces the attach at the full configured limit. Old parser writes drain before reset; canceled callbacks cannot reset the new screen or acknowledge its bytes. Size events remain ordered with output. New bytes waiting behind reset are bounded by the existing manual-ACK window.
- The latest viewport and selection are captured immediately before reset. Nearby matching row text anchors them across output arriving during the attach wait; this avoids treating unseen live output as prepended history. Identical repeated rows use the nearest matching row as a candidate only. The complete restored selected text must equal the captured selection; a missing anchor or a mismatch clears the selection instead of leaving different text available to copy. Expired/rewritten content cannot acquire a stable identity from this protocol.
- Hydrated history stays cached until unmount, including when returning to the bottom. This protects ongoing selection/search and avoids repeated snapshot parsing. A disposed view explicitly drops its local history cells; remount/reconnect retrieves authoritative state normally. Settings changes reattach with the new limit, and exited PTYs can still hydrate their retained screen.

The architecture document's terminal section is updated. Runtime retention, PTY sizes/jobs, session JSON, existing idle-suspend policy and mobile's chosen attach limit are preserved. No new runtime capability or persistence format is introduced.

## Workload and measurement

Node 22.23.3, Electron 42.11.16, xterm 5.5.0; macOS arm64, Darwin 25.3.0. Each fresh isolated Electron HOME/device profile opens an empty workspace and a shown 1400×950 window. All 20 or 50 overlapping terminal panels are mounted. **Final comparisons use production rendering**, including the existing two-WebGL-view budget; the resulting grids are 89 columns for those two views and 86 for the others, all 26 rows.

Each real PTY runs a persistent Node job printing 10,000 numbered, ANSI-colored tool-log rows with a path, JSON, accented/combining characters, wide CJK and emoji. It then emits a heartbeat each second. Idle suspension is disabled only in the temporary workspace. These are agent-like workloads, not authenticated agent CLIs. The test checks the parsed completion marker in the retained tail, accesses an older `AGENT-08500` match, selects all, scrolls all views, unmounts/remounts, and verifies ongoing heartbeats, unchanged PTY IDs/PIDs, alive status and no suspension. Only fixture teardown stops the isolated jobs.

After a one-second settle, diagnostic CDP GC precedes renderer heap/backing samples; there is no production forced-GC policy. Cell bytes are summed from actual retained normal-buffer line arrays; private xterm fields are used only by the profiler. `vmmap -summary` measures renderer, runtime and GPU footprint. Runtime GC is not forced. Memory columns overlap and must not be added. This is neither peak-memory measurement nor unique system RAM accounting.

| Following live output | 20 baseline | 20 candidate | 50 baseline | 50 candidate |
| --- | ---: | ---: | ---: | ---: |
| Client cell backing, MiB | 40.02 | 3.04 | 99.84 | 7.59 |
| Renderer backing, MiB (CDP) | 44.85 | 7.02 | 106.39 | 12.21 |
| Renderer JS heap, MiB (CDP) | 38.56 | 18.19 | 79.25 | 27.96 |
| Renderer footprint, MiB | 228.20 | 153.60 | 450.50 | 256.50 |
| Runtime footprint, MiB | 377.50 | 388.30 | 738.00 | 683.60 |


Final 20-panel values are medians of three independent launches per variant. Fifty-panel values are one launch per variant. Matching baseline builds restore the three changed product entry files exactly from `git show ba6fc778`, leaving the new helper unimported; candidate files are then restored and hash-verified. No own rebuild overlaps own profiling, and sources remain frozen within measurement batches. All heavy profiles, heap attribution and real-Electron integration runs acquire atomic `mkdir /private/tmp/cate-ram-round2-profile.lock`, record track/PID ownership, wait at most 60 one-second retries, and release in `finally` only if owned. Other tracks' locks were respected. The host is shared and not otherwise guaranteed quiescent.

## History access and output cost

| Elapsed time, ms | 20 baseline | 20 candidate | 50 baseline | 50 candidate |
| --- | ---: | ---: | ---: | ---: |
| First Select All | 32 | 125 | 73 | 150 |
| First older-history search | 22 | 129 | 43 | 143 |
| Native upward scroll, all views | 5 | 401 | 88 | 639 |
| Initial live PTY fill | 948 | 964 | 2,356 | 2,378 |


Times include actual input/PTY processing and Playwright completion polling; they are UI-observed elapsed times, not isolated serialization costs. At first scroll, two views have already hydrated through Select All/search, so the scroll stage hydrates the other 18 or 48 concurrently. This is deliberately heavier than one person's first wheel movement. The history scrollbar grows to the full range on hydration; the current visible text is anchored, then scrolling continues through the older rows.

Sampled initial live-fill throughput is **210,970 → 207,469 rows/s** at 20 panels (median elapsed time +1.7%), and **212,224 → 210,261 rows/s** at 50 (+0.9%). Candidate 20-panel fills ranged from 962 to 2,194 ms; baseline from 929 to 1,039 ms. The median uses all three launches, including the slow candidate sample.

The live-fill workload includes process startup and delivery/parsing of 200,000 or 500,000 PTY rows. It is not a sustained authenticated-agent benchmark, and the samples do not justify a general throughput speedup claim. A slow candidate fill sample is retained rather than discarded.

Once all views hydrate, cell storage is identical to the baseline, demonstrating that history remains available. On remount the candidate returns to the small cache:

| After hydration then remount | 20 baseline | 20 candidate | 50 baseline | 50 candidate |
| --- | ---: | ---: | ---: | ---: |
| Client cells, MiB | 40.02 | 3.04 | 99.84 | 7.59 |
| Renderer backing, MiB | 45.79 | 7.36 | 108.94 | 13.06 |
| Renderer footprint, MiB | 214.80 | 160.70 | 403.40 | 271.60 |


Runtime/GPU details are preserved in raw data. Following-output runtime footprints were 377.50 → 388.30 MiB at 20 panels and 738.00 → 683.60 MiB at 50. Earlier matching batches changed these values substantially without runtime code changes; the raw data keeps those runs. Final following-output GPU samples ranged from 912.7 MiB to rounded GiB-scale values; no consistent GPU reduction was established. No runtime/GPU saving is claimed, and no total-Cate RAM percentage is inferred from the renderer result.

## Iterations and rejected approaches

1. Rejected merely lowering the configured history and a tail without hydration: both would remove accessible history. Incremental page splicing would require substantially more indexing/reflow/VT-state machinery; the existing atomic full-snapshot attach is sufficient for this cache experiment. The 128-row choice supports native scrolling and several screens at the measured grid. No new user setting is needed.
2. Early DOM-forced runs proved the cache allocation reduction but exposed disposed full histories retained after remount: about 47.85 MiB renderer backing at 20 panels and 115.27 MiB at 50, despite fresh tail-sized live views. Extra GC did not fix it. A locked heap snapshot found old terminal cells retained through xterm's WebGL atlas `ownedBy` cache: failed renderer construction registers listeners before checking the WebGL context; later hydration resets reach those listeners and acquire atlas entries. This is an existing xterm failure path activated by the new lifecycle. Explicitly trimming local history before disposing releases those large cell arrays even if an old terminal object remains referenced. Upstream renderer metadata retention is not fully repaired here. Final comparisons use normal rendering and include this disposal fix; earlier runs remain diagnostic-only.
3. The existing 2,000/5,000/500-row integration test caught native-scroll event suppression. The initial API-only trigger was incomplete. Added the viewport listener, a disposal test, native scrolling in the profiler, and reran the configured-limit integration successfully.
4. Auditing interaction during hydration identified length-only selection anchors as insufficient when live output advances. Added the parser-barrier capture hook and text anchoring, with a delayed-gesture/unseen-output test. The new unit test also explicitly waits for the initial screen before queuing old output, so it verifies a real parser drain rather than canceled unparsed data.
5. Initial sandboxed Electron launch failed; isolated profiling required execution outside the sandbox. Several bounded lock waits expired without changing another track's lock. An early fill assertion inspected only the last row and missed a marker displaced by heartbeats; it now checks the retained tail. Failed attempts contribute no savings samples.

The first-round 16 KiB parser-write bound is retained from the baseline. No parser scratch saving is counted as this experiment's history saving.

## Selection review follow-up

The consolidated review requested full-selection verification rather than trusting the start-line anchor. Added a repeated-line, multi-line regression with ten unseen output rows: the nearest repeated header belongs to a different payload, so the restored text is rejected and the selection cleared. Existing valid-selection coverage now explicitly checks that it is retained. The follow-up passed 165 tests across the same 24 targeted unit/protocol files, typecheck, dependency rules and targeted lint. No new 20/50-panel or alternate-screen memory profiling was performed. The earlier real-Electron lifecycle/history checks had already completed successfully before this selection-only fix.

## Validation, limitations and reproduction

Passed: desktop and runtime builds; 164 tests across 24 targeted terminal service/binding/view/renderer/mobile files; typecheck; dependency rules; targeted ESLint; real-PTY profiles at 20 and 50 panels; the existing real-Electron configured-history/remount test; and the existing 12-real-PTY lifecycle regression. That final lifecycle run verified output advanced while views were unmounted, retained the same live unsuspended PTYs, and remounted to a heartbeat in 198 ms. New coverage includes Unicode/SGR and UTF-8 boundaries, alternate-screen TUIs/modes, snapshot-boundary output exactly once, grid changes, exit hydration, resumed snapshots, canceled subscriptions, transport failure/disposal, deferred search, native/public scrolling, selection anchoring and cache eviction. The profile independently exercises actual search and Select All outside the initial tail and live-job remounts.

This is a complete local experiment, not a sustained cross-platform/remote-network certification. Remote clients use the same existing attach semantics, but added RTT, large custom histories, encrypted network transports and native-mobile rendering were not profiled. Hydrating every open panel removes the live-cache saving until views unmount. Text anchors cannot disambiguate truly identical repeated rows with different identities; the follow-up verifies full copied text and clears unverifiable selection ranges. GPU/compositor caches, Node GC timing and other host work limit process-footprint generalization. Allocation peaks, memory pressure, many reconnects during continuous full-screen TUIs, and long authenticated-agent soaks remain unmeasured.

Raw measurements: [terminal-history-round2-2026-11-13-raw.json.gz](terminal-history-round2-2026-11-13-raw.json.gz). The raw file preserves numeric samples, first/last rows, diagnostics, retainer evidence, source hashes and failed-attempt notes; repetitive generated tail text is omitted. The large local heap snapshot is referenced rather than committed.

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run build
npm run build:runtime
# Each profile owns the shared round2 lock internally. Finish builds first.
CATE_HISTORY_ROUND2=1 CATE_HISTORY_VARIANT=candidate \
  npx playwright test e2e/terminal-history-round2.spec.ts --repeat-each=3 \
  --output=/private/tmp/history-round2-reproduce-20
CATE_HISTORY_ROUND2=1 CATE_HISTORY_COUNT=50 CATE_HISTORY_VARIANT=candidate \
  npx playwright test e2e/terminal-history-round2.spec.ts \
  --output=/private/tmp/history-round2-reproduce-50
npx vitest run src/services/terminal src/shells/desktop/ui/panels/terminal \
  src/shells/desktop/renderer/renderer.test.tsx src/shells/mobile/core/terminals.test.ts
npm run typecheck
npm run lint:deps
```

For the exact baseline, save the candidate versions of `binding.ts`, `TerminalView.tsx` and `parts/xterm.ts`; restore those three from `ba6fc778`, rebuild, run the same profiler with a distinct variant/output directory, then restore the saved files and rebuild. Never switch source or rebuild during an active profile. `CATE_HISTORY_DOM=1` reproduces the DOM diagnostic; `CATE_HISTORY_HEAP=1` additionally saves a renderer heap snapshot while the profile owns the lock. The standalone existing `e2e/terminal-scrollback.spec.ts` must also be run inside an owner-checked round2 lock wrapper; it does not acquire this experiment's lock itself. Nothing is pushed or merged.
