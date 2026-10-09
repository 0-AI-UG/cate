# Refactor plan: from the runtime refactor to a clean architecture

Source: two reviews of `refactor/runtime-architecture` (2026-10-07), one for
bugs, one for boundaries, plus a check of `../cate-connect`. This plan is
written for an agent that implements it without the review conversation.

- **Part 0**: how to work (read first).
- **Part 1**: bugs B1..B34. Each one is proven by a failing test before it
  is fixed.
- **Part 2**: the target: one way per concern.
- **Part 3**: reworks R1..R13 that get there.
- **Part 4**: order.

---

## Part 0: How to work

### Setup
- Node: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` (the default node
  26 breaks the Electron install and `node:sqlite`).
- Checks: `npm run typecheck`, `npm run lint`, `npm run lint:deps`,
  `npm test`; e2e with `npm run test:e2e` (Playwright, `e2e/`).
- Test helpers that already exist, use them before writing new ones:
  - `src/test/sharedWorkspace.ts`: a real daemon in a temp HOME with two
    real clients (A local, B paired over the same-network transport). Tests
    under `src/test/shared/*.test.ts`. Use it for anything that involves a
    client and a runtime.
  - `src/runtime/daemon/daemon.workspace.test.ts`: a real daemon over its
    socket.
  - `src/workspace/document/contract/convergence.test.ts`: several clients,
    random ops, drops and reconnects.
  - `src/runtime/connect/testing/standIn.ts`: a Cate Connect stand-in.
  - `src/workspace/repository/runtime/testGit.ts`: temp git repositories.
  - `../cate-connect/test/`: the service's own vitest suite.
- Read `docs/architecture.md` sections for the area before touching it.
  When a fix or rework changes the model, change the document in the same
  commit; the document wins over the code.

### Bug workflow (mandatory)
For every bug, in this order:
1. Write the test named in the bug's **Test** line, in the place named
   there (or the nearest existing test file for that module).
2. Run it and confirm it **fails for the stated reason** (read the failure,
   not just the red). Note the failure in the commit message.
3. If it does not fail, the bug is not reproduced: do not fix anything.
   Add a line under the bug in this file, "Not reproduced: <what the test
   showed>", keep the test only if it guards a real invariant, and move on.
4. Fix with the smallest change that makes it pass.
5. Run the module's tests and `npm run typecheck`.
6. One commit per bug: `Fix <what>` with the test in the same commit.

Reworks have their own **Done when** checks; write those tests first where
they are tests.

### Design rules for every change
- **No abstraction without two users.** A new interface, port, registry or
  helper is allowed only when it replaces two or more existing
  implementations, or when it is the boundary between layers or between the
  core and a shell. Otherwise move or delete code instead.
- **Prefer moving and deleting over wrapping.** Most reworks below are
  "this code is in the wrong place" or "this exists twice": move it, delete
  the copy, do not add an adapter between them.
- **Clean cuts** (architecture section 18): no shims, no re-exports from old
  paths, no migration code, no feature flags.
- A port gets only the members its callers use today. No speculative
  methods.

### Conventions
- Commit messages and PR text: no `Co-Authored-By` lines, no "Generated with
  Claude Code" footer, no em dashes.
- Do not push to `../cate-connect` `main`: pushing deploys the live service.
  Prepare the commit there and stop for the user (B8).
- The working tree had uncommitted edits in
  `src/shells/desktop/ui/services/agents/{contextTransport.ts,tabDecorations.tsx,index.ts}`,
  `src/shells/desktop/ui/workspace/relations/*` and
  `e2e/agent-context.spec.ts`. Ask the user whether to land or drop them
  before starting R4 or R8, which rewrite those areas.
- A few git tests fail when the dev tree has a `main` branch or local
  changes; those failures are environmental (CLAUDE.md).

---

## Part 1: Bugs

Severity: **P0** data loss, wrong process killed, lockout, security bypass;
**P1** wrong behaviour in normal use; **P2** hardening.

### P0

**B1. Reopening a workspace drops new document ops as duplicates.**
`client/connections/identity.ts:19` picks one `clientId` per app launch;
`client/document/store.ts:88` and `kernel/rpc/client/client.ts:74,150`
restart their op counters at 0 for every new store or connection. The
runtime keeps the highest counter per `clientId`, persisted in
`document.json` (`workspace/document/contract/sequencer.ts:60`) and cached
in `kernel/rpc/runtime/server.ts:164`.
- Test (integration, `src/test/shared/document.test.ts`): client A proposes
  5 `updatePanel` ops, closes its connection, opens a new
  `WorkspaceConnection` with the same identity, proposes one more; assert
  the runtime document has the 6th change. Fails today: status `duplicate`.
- Fix: the counter belongs to the identity. Add `nextCounter()` to
  `ClientIdentity`; the document store and the rpc client take counters from
  it and hold none. `RpcServer` answers an evicted duplicate with
  `RpcError('duplicate')`, never `{result: undefined}`; `store.ts:183`
  treats a missing `status` as a failure instead of throwing in `.then`.

**B2. Two daemons can serve one workspace.**
`runtime/data/runtime/socketLock.ts:36-39` probes the socket once, waits up
to ~6 s for the previous owner (`awaitPreviousOwner`), then unlinks whatever
socket is there.
- Test (integration, `src/runtime/data/runtime/socketLock.test.ts`): write a
  `runtime.json` whose pid is the test process (alive, not a daemon), start
  two `acquireRuntimeSocket` calls 100 ms apart with a short `ownerExitMs`;
  assert exactly one returns a bound server and the other `running`, and the
  bound one still accepts connections. Fails today: both bind.
- Fix: probe again immediately before unlinking; on `EADDRINUSE` at the
  final `listen`, probe and return `running`. Ask `ps` whether the old pid is
  a daemon before waiting on it, not after.
- Also: `shells/desktop/main/transports.ts:76-79`, waiters on a pending
  start share its result including failure; they never each spawn. Test:
  unit test in that folder with a failing `startLocal` stub and three
  concurrent callers; assert one call to `startLocal`.

**B3. The server reaper can SIGKILL unrelated processes.**
`runtime/server/runtime/serverHost.ts:71-82` kills every recorded pid whose
owner daemon is gone, without checking it is still that server
(`startedAt` is recorded and unused). `servers.json` is written with a
plain `writeFileSync` (line 65).
- Test (unit, `serverHost.test.ts`): spawn `sleep 30` outside the host,
  write a pid file recording its pid with a different command and an owner
  pid that does not exist, run `reapOrphanServers`; assert the process is
  still alive. Fails today: it is killed.
- Fix: record `{pid, ownerPid, command, startedAt}` with `startedAt` read
  from the OS (`ps -o lstart= -p <pid>` right after spawn); reap only when
  both command and start time match. Write the file through
  `kernel/state` (atomic).

**B4. Closing a terminal never ends its agent state.**
`services/terminal/runtime/terminalService.ts:709` (`close`) sets
`term.alive = false` before node-pty's exit callback; `onPtyExit` (`:515`)
then returns early, exit observers never fire, and
`services/agents/runners/terminal/terminalRunner.ts:180` never calls
`forget`.
- Test (unit, `terminalService.test.ts`): register an `onExit` observer,
  spawn, `close(id)`; assert the observer was called once. Then in
  `terminalRunner.test.ts`: after close, `liveTerminal(panelId)` is null.
  Fails today: observer never called.
- Fix: one `endTerminal(term, exitCode)` used by `onPtyExit`, `close` and a
  failed spawn (B5); it notifies exit observers once, then disposes.

**B5. A failed spawn leaves the agents runner pointing at a terminal that
does not exist.** `terminalRunner.ts:152` registers the terminal in its env
contributor before the PTY exists.
- Test (unit, `terminalRunner.test.ts`): make the PTY factory throw; assert
  `liveTerminal(panelId)` is null and `send` answers `agent-not-running`.
- Fix: B4's `endTerminal` on every spawn failure, including the trust
  re-check.

**B6. Undoing a panel close brings the panel back with empty state.**
`panels/framework/runtime/sessionHost.ts:82-88` deletes `sessions/<id>.json`
on removal; undo (`workspace/document/contract/invert.ts:73`) re-adds the
same id.
- Test (integration, `src/test/shared/review.test.ts`): create a review
  panel, add a note, remove the panel, apply the inverse op from
  `invert.ts`; assert the note is in the session snapshot. Fails today:
  notes are empty.
- Fix: on removal, rename the file to `sessions/removed/<id>.json`; when a
  record with that id is added, the host restores from there. The daemon
  deletes `removed/` entries older than 24 h at start. In the same change,
  `sessionStore.ts:38-39` `remove()` awaits the in-flight write first (that
  race could delete a file the next session already wrote; cover it with a
  unit test that removes during a pending write).

**B7. A crash can rewind the document sequence without clients noticing.**
`sequencer.ts:70-75` answers `since(from)` with `[]` when `from === seq`,
even if that seq belongs to a previous daemon start; the document is written
with a 250 ms debounce.
- Test (unit, `convergence.test.ts`): runtime at seq 10, client mirror at
  10; build a new sequencer from the state at seq 7 (simulated crash); a
  second client applies 3 ops; the first client resumes with `since(10)`;
  assert the mirrors converge. Fails today: the first client gets `[]`.
- Fix: the document service picks a random `epoch` at each start; the
  subscribe call carries `{epoch, sinceSeq}` and a different epoch answers a
  full snapshot. The client stores the epoch beside its seq.

**B8. Cate Connect locks a workspace out forever, and a runtime id can be
claimed by anyone.**
Verified in `../cate-connect/src/service.ts:234-243` and `src/store.ts`: the
first key to register a runtime id owns it permanently (`bindings.json`, no
expiry). The runtime id is a hash of the workspace path
(`src/runtime/data/contract.ts:10`), so:
- the same path on two machines (`/home/ubuntu/app`, `~/Dev/x`) collides and
  the second is refused forever;
- a workspace whose `secrets.json` is deleted or quarantined gets a new key
  (`runtime/data/runtime/secrets.ts:26`) and is refused forever;
- anyone who can guess a path can claim it first.

The same path hash is also the mDNS name (path leak), and pairing replaces a
pinned key without a check (`runtime/pairing/client/knownRuntimes.ts:39`),
so a QR code for a known id with another key silently re-pins it.
- Tests:
  - cate-connect (`../cate-connect/test/`): two runtimes with different keys
    register the same id; today the second gets `key-mismatch`. After the
    fix: registering an id that is not derived from the Noise static key is
    refused, and two different keys can never produce the same id.
  - cate (`src/runtime/connect/connect.test.ts` with the stand-in): a
    runtime whose key changed registers and is reachable.
  - cate (`src/runtime/pairing/client/pair.test.ts`): a pairing answer whose
    static key does not derive the code's id is rejected and
    `known-runtimes.json` is unchanged.
- Fix: the network identity is the key. `networkId = first 16 base32 chars
  of sha256(runtime public key)`, the same format as a runtime id.
  - The runtime registers on Cate Connect and announces on mDNS under its
    `networkId`; pairing codes carry the `networkId`.
  - The service checks `networkIdOf(noise static key) === message.runtimeId`
    and keeps no bindings: delete `bindings.json` and `fileBindings`. Bump
    `CONNECT_PROTOCOL` (clean cut; `src/runtime/connect/contract/protocol.ts`
    mirrors the service's `protocol.ts`).
  - Clients check `networkIdOf(remoteStatic) === id` on every network
    connect and at pairing; `pin()` refuses a different key for a pinned
    id.
  - The path-hash runtime id stays the local data directory and socket name
    only.
- Deploy: land the cate side first, prepare the cate-connect commit, and
  stop for the user to deploy. Released apps on protocol 1 lose Cate Connect
  until they update; say so to the user.

**B9. The review panel runs git and `gh` without the trust gate.**
`panels/runtime.ts:136-156` hands the review session the raw `git` and
`monitors` of `RepositoryRuntime`; only `vcsCapabilityImpl` checks trust
(`workspace/repository/runtime/repository.ts:318-329`). `chatChanges` in the
same file does the same.
- Test (integration, `src/test/shared/review.test.ts`): untrusted workspace,
  review panel, send `commit`; assert it fails with `untrusted` and no
  commit exists. Fails today: it commits.
- Fix: R3 (the gate moves into the repository runtime). Do R3's
  repository part now, as this bug's fix.

**B10. Shutdown can lose the last state writes.**
`runtime/daemon/entry.ts:241-273` and `compose/workspace.ts:435-453` flush
document, settings, pairings and trust last, after T3 dispose (10 s fetch
timeout) and terminal shutdown, inside a 5 s deadline.
`workspace/document/runtime/documentService.ts:172-184` writes synchronously
while a debounced async write may be in flight.
- Test (integration, `daemon.workspace.test.ts`): stub T3 dispose to hang,
  apply a document op, stop the daemon; reread `document.json`; assert the
  op is there. Fails today: the op is lost.
- Fix: shutdown flushes every state store and session first, then disposes
  services, each with its own timeout. The deadline handler flushes again
  before exiting. `document.json` moves onto `kernel/state` (R12), which
  already handles the in-flight write; do that move as part of this fix.

**B11. A worktree interrupted during create or remove can never be removed.**
`workspace/repository/runtime/repository.ts:186,219`: `creating` and
`removing` records survive a crash and every later operation refuses them.
- Test (unit, `repository.test.ts` with `testGit`): seed a document with a
  `creating` worktree whose folder does not exist and a `removing` one whose
  folder exists; start the repository runtime; assert the first record is
  gone and the second is removed from disk and document.
- Fix: at start, reconcile each non-`ready` record against
  `git worktree list --porcelain`: present becomes `ready`, absent is
  dropped, `removing` finishes.

### P1

**B12. Network clients are served before the workspace is restored.**
`entry.ts:323-343` starts the network listener before `ws.start()`.
- Test (integration, shared workspace): delay `ws.start()` in a test hook;
  connect client B; subscribe to a panel that exists in `document.json`;
  assert the subscribe succeeds after start (today: `gone`).
- Fix: network connections wait for `open()` exactly like local ones.

**B13. Workspace settings stop updating after a reconnect.**
`kernel/settings/client/workspaceSettingsMirror.ts:68` subscribes without
`resume` and ignores `done`.
- Test (integration, `src/test/shared/settings.test.ts`): drop A's
  connection, reconnect, change a workspace setting from B; assert A sees it.
- Fix: `resume: true` (R7 later makes every watched state resumable).

**B14. A late watcher echo of an earlier write overwrites a newer edit.**
`kernel/state/contract/store.ts:144,212-217` remembers only the last
written content.
- Test (unit, `kernel/state/contract/store.test.ts`): set A, flush, set B,
  then deliver the external event for content A; assert `current` is B and
  B is on disk.
- Fix: keep the hashes of written contents not yet echoed (cap 16, expire
  after 2 s); an external event whose hash matches is an echo.

**B15. The daemon blows the client's 10 s start budget.**
`runtime/daemon/main.ts:74`, `entry.ts:130`: the login-shell environment
capture (up to 8 s) runs before the socket is bound, and B2's wait comes on
top.
- Test (integration, `daemon.workspace.test.ts`): stub the shell-env capture
  to take 8 s; assert the socket answers within 1 s of spawn.
- Fix: bind first; capture the environment lazily on the first PTY or
  server spawn.

**B16. The build id ignores parts of the install.**
`scripts/build-id.mjs:29-42` hashes only `src/`.
- Test (unit, next to the script): the id changes when a file under
  `skills/`, `scripts/patch-t3*.mjs` or `package-lock.json` changes.
- Fix: include those inputs.

**B17. `cate serve` on a running workspace does not trust it.**
`runtime/daemon/main.ts:35-38,113-127`.
- Test (integration): start a daemon untrusted, run the `serve` path; assert
  trust is granted (architecture 7.1).
- Fix: `pairOverLocal` sets trust like `trustOnStart`.

**B18. Concurrent installs and pruning can remove a live install.**
`runtime/daemon/node/install.ts:79-84,206-247`.
- Tests (unit, `install.test.ts`): two installs of one build interleaved at
  the rename; assert a complete install exists at every step. Prune while a
  spawner's marker exists; assert the build is kept.
- Fix: only move aside an install without the `.ok` marker. The spawner
  writes `~/.cate/runtime/<build>/in-use/<pid>` before spawning; pruning
  skips builds with a live marker; the daemon removes its marker on exit.

**B19. `daemon.out.log` grows forever.** `install.ts:265`, `main.ts:71`.
- Test (unit): open the log with an existing 6 MB file; assert it is
  truncated.
- Fix: stop copying console warn and error into it (they are in the rotated
  `daemon.log`); truncate it at start above 5 MB.

**B20. A watcher error silently stops events for every subscriber.**
`workspace/files/runtime/watchPool.ts:126`.
- Test (unit, `watchPool.test.ts`): two subscribers, inject a watcher error,
  then change a file; assert both subscribers get an event.
- Fix: keep the subscribers, re-create the watch with backoff, send each a
  `rescan` event.

**B21. Restarting T3 can run two harnesses on one state directory.**
`services/t3/runtime/t3Runtime.ts:236,368`, `runtime/server/runtime/serverHost.ts:211`.
- Test (unit, `t3Runtime.test.ts` with a fake server that exits slowly):
  restart, then request the panel URL at once; assert the second start
  begins only after the first process exited.
- Fix: stop awaits exit (SIGTERM, 3 s, SIGKILL); starts and stops are
  serialized per checkout.

**B22. Revoking trust stops nothing.** `compose/workspace.ts:405` reacts
only to granting.
- Test (integration, shared workspace): trusted workspace with a terminal,
  a status monitor and a T3 harness; revoke trust; assert no PTY and no
  harness is alive and the monitor stopped.
- Fix: R3.

**B23. Opening and saving a file changes its bytes.**
`workspace/files/runtime/buffers.ts:186,245`.
- Test (unit, `buffers.test.ts`): a file with a UTF-8 BOM and a Latin-1
  file; open, save unchanged; assert the bytes are identical (Latin-1:
  opens read-only, save refused).
- Fix: keep the BOM as buffer metadata and write it back; invalid UTF-8
  opens read-only.

**B24. A failed agent start reports success or leaves a T3 thread running.**
`services/agents/runtime/start.ts:163,168-181`.
- Test (unit, `start.test.ts`): relaunch rejects; assert the start rejects.
  `createChat` rejects after `startThread`; assert the thread was stopped.
- Fix: no `.catch(() => {})`; stop the thread before removing the worktree.

**B25. Restored browser tabs point at a dead URL.**
`panels/browser/session.ts:130-163,233` persists the served URL
(`http://127.0.0.1:<port>/<per-start token>/...`).
- Test (integration, `src/test/shared/browser.test.ts`): open a workspace
  HTML file in a browser panel, restart the daemon; assert the restored tab's
  URL uses the new server's port and token.
- Fix: a file tab persists its workspace path and is re-served in
  `start()`.

**B26. Two dirty editors on one file both close in one batch.**
`panels/editor/session.ts:154-159,222-229`.
- Test (integration, `src/test/shared/editor.test.ts`): two editors on one
  file, edit, `removePanels` both without `discard`; assert it fails with
  `dirty`.
- Fix: `prepareClose` receives the whole removal set; only editors outside
  it count as keeping the buffer.

**B27. A record change or undo switches a dirty editor's file.**
`panels/editor/session.ts:461-470` rebinds without the `dirty` check.
- Test (integration, `editor.test.ts`): edit `a.ts`, apply the inverse of
  the `openFile` record change; assert the edit is not lost (buffer still
  bound to a panel or the op refused).
- Fix: R8 (the open file becomes session state).

**B28. A cancelled multi-panel close leaves the discard flag set.**
`panels/editor/session.ts:158`.
- Test (integration, `editor.test.ts`): prepare close with discard for A,
  cancel; later remove A by undoing its `addPanel`; assert A's edits are
  not reverted.
- Fix: the answer travels in the op (`removePanels {discard: PanelId[]}`,
  architecture 11.2 rule 6); the session keeps no flag.

**B29. Page operations ignore the API timeout and cancellation.**
`panels/browser/session.ts:348-350` uses the surface broker's 30 s default.
- Test (unit, `surfaces.test.ts`): a page op with a 35 s spec timeout and a
  driver that answers at 32 s (fake timers) succeeds; aborting the call
  rejects the surface request at once.
- Fix: `withSurface(op, {timeoutMs, signal})`, passed from the API call.

**B30. Review ignores a checkout change while busy.**
`panels/review/session.ts:258-261,509`.
- Test (unit, `review` session test): start a slow `commit`, change the
  record's checkout; assert the session switches after the commit ends.
- Fix: queue the change and apply it when the busy operation ends.

**B31. Client core: undo, closed channels, growing counters.**
- Undo pops twice when a propose fails (`client/document/store.ts:220-228`).
  Test (`store.test.ts`): make the first undo entry fail to propose; assert
  one Cmd+Z leaves the older entry in place. Fix: pop only after a
  successful local propose.
- A closed channel keeps its last snapshot (`kernel/rpc/client/channel.ts:38,47`).
  Test: end a channel with a `gone` reopen; assert listeners are notified
  with `null`. Fix: notify when `state` becomes null.
- Per-client counters grow forever (`documentService.ts:113`,
  `kernel/rpc/runtime/server.ts:108`). Test: counters for a client not seen
  for 8 days are gone after start. Fix: persist `lastSeen` per client, prune
  at start after 7 days; one global LRU for `RpcServer.ops`.

**B32. A shared test flakes under load.**
`src/test/shared/session.test.ts` "resumes on the new PTY" timed out once in
the full suite, passes alone.
- Test: run it 20 times under `--pool=forks` with the full suite; record
  the failure rate.
- Fix: wait on the PTY restart event instead of polling a fixed deadline.

### P2

**B33. Network hardening.**
Each item gets a unit test in the named module that fails today.
- Pre-auth slots (`runtime/transports/runtime/networkPeers.ts:46,61`): 32
  unproven connections from Cate Connect lock out LAN clients. Fix: a
  budget per transport.
- One wrong pairing proof burns every live secret
  (`runtime/pairing/runtime/pairingService.ts:146`). Fix: burn a secret
  after 5 wrong proofs.
- `closeAll()` (`runtime/daemon/runtime/network.ts:65,91-95`) misses
  handshakes in progress, and switching to `sameNetwork` keeps WebRTC
  sessions. Fix: close both.
- Removing a device by editing `pairings.json` keeps its live connection.
  Fix: the store's external-change handler revokes removed devices.
- A pin mismatch on the first LAN endpoint aborts the dial
  (`runtime/transports/client/network.ts:63-80`). Fix: try the remaining
  endpoints and Cate Connect.
- Windows named pipe has no ACL (`runtime/data/node/paths.ts:48`). Fix: a
  security descriptor for the current user only. Test only on Windows CI;
  otherwise document as untested.
- `shells/desktop/main/natives.ts:97-99` `openExternal` accepts loopback
  URLs (D10). Fix: refuse loopback there, so every caller is covered.

### Tooling

**B34. Checks that do not check.**
- `npm run lint` fails locally with 2,029 errors from generated iOS bundles
  (`ios/build/**`, `ios/Cate/Core/Web/core.js`). Fix: add them to the
  eslint ignores. Test: `npm run lint` exits 0 with an iOS build present.
- `.dependency-cruiser.cjs` misses whole areas: `push` is not in
  `RUNTIME_MODULES`; `src/cli` is in no zone; panel root files
  (`session.ts`, `runtime.ts`, `definition.ts`) and `agents/runners/` are
  outside every side rule. Test first: add `test/depcruise-fixtures/` with
  one file per rule that must be rejected (a panel `session.ts` importing
  `@client/host`, a `definition.ts` importing `node:fs`, a `runtime/push`
  file importing `@client/host`, a CLI file importing another module's
  internals) and a vitest that runs depcruise on them and expects each
  violation. It fails today for 4 of 5. Fix: R2.

---

## Part 2: The target, one way per concern

| Concern | The one way | Deleted alternatives |
|---|---|---|
| Lists of settings, capabilities, API specs | Top-level index files (like `src/panels/definitions.ts` today), read by the composition roots | Lists inside `kernel/settings`, `kernel/api`, `client/connections` |
| Dependency rules | Every runtime file is under a runtime rule, every client file under a client rule, proven by fixtures | Panel root files and runners outside the rules |
| Client talks to runtime | Typed capabilities (services) and session ops (panels) | Clients calling `api.call`, unused ops, duplicate input paths |
| Callers outside the UI | The `cate` API, whose handlers call the same service functions and session ops | Logic written once for clients and again for the API |
| Watching state | `channelStream` (snapshot, changes, resume) | Full-resend streams and non-resumable subscriptions |
| Runtime asks a client | The surface broker, choosing a client by the feature the op requires | Op-prefix routing, per-view registries, browser-only assumptions |
| Trust | Enforced inside each runtime that runs processes, at construction | `requireTrusted()` at capability edges only |
| Persistence | Every JSON file through `kernel/state` | `documentService`'s own write loop, raw `writeFileSync` |
| Agent state | `services/agents` only; runners private | Agent fields in the chat snapshot, `ChatBindings`, stamps in the terminal session, `runner` branches in shells |
| Notifications | A notifications module agents, terminal and the API publish to | `agents.notifications` as the general bus; gating in the desktop UI |
| Client startup | One `startClientCore` function both shells call | Hand-written boot sequences, slots installed by hand |
| Logic both shells need | In the core (`client/` sides, `panels/<type>/client`) | The same logic in `shells/desktop/ui` and `shells/mobile/core` |
| Electron concepts | `desktop/` sides and the desktop shell only | Partitions and cookies in `client/` sides |
| Generic code and panel types | Definition flags or record data | `type === 'canvas'`, `op.startsWith('chat.')` |
| Network identity | Derived from the runtime key (B8) | Path hash on mDNS and Cate Connect |
| Client/runtime compatibility | Protocol version | Build-hash lockstep |

---

## Part 3: Reworks

Each rework lists what it deletes. Abstractions it introduces are named
explicitly with the implementations they replace; nothing else is added.

### R1. The kernel knows no feature

Problem: `kernel/settings/contract/composed.ts` imports a settings slice from
every layer, including `@shells/desktop/contract/settings`, so the daemon
and the iOS core bundle desktop-only settings and kernel modules import each
other (`kernel/settings` with `kernel/api` and `kernel/interaction`).
`kernel/api/contract/permissions.ts:38-110` hard-codes feature areas.
`client/connections/capabilities.ts` imports every capability, including
panel ones (an upward import).

Change (no new abstraction; move lists up, as panels already do):
- `src/settings.ts`: the list of shared settings slices, composed with the
  existing `composeSettings`. The daemon and both shells import it.
  `src/shells/desktop/settings.ts` adds the desktop-only slices for the
  desktop's client settings store. The settings capability and stores take
  the table they are given (they already accept one:
  `workspaceSettingsStore.ts:38`, `clientSettings.ts:25`).
- `src/capabilities.ts`: the capability list, passed to
  `WorkspaceConnection` (the option exists, nobody passes it) by
  `startClientCore` (R5). Keep the compile-time completeness check there.
- Permission areas: `defineCateApi` gets an `area` field per spec; the
  router derives the area table from `CATE_API`.

Delete: `kernel/settings/contract/composed.ts`, the list in
`client/connections/capabilities.ts`, the area table in `permissions.ts`,
the `SLICE` exemption in `.dependency-cruiser.cjs`.

Doc: sections 3, 6, 8, 14, 17.
Done when: a dependency rule "kernel imports only kernel" passes; the
coupling report shows no kernel cycles; the iOS bundle (`npm run
build:mobile`) contains no desktop settings slice (grep its output for a
desktop-only key such as `sshMachines`).

### R2. Dependency rules that cover everything

Change:
- In `.dependency-cruiser.cjs`, classify by path: `panels/<type>/session.ts`
  and `panels/<type>/runtime.ts` are runtime side; `definition.ts` is a
  contract; add `push` to `RUNTIME_MODULES`; add a `cli` zone (it may import
  contracts, `kernel/rpc/client`, `src/panels/*.ts` index files).
- Move `services/agents/runners/*` to `services/agents/runtime/runners/*`
  (runner code is runtime code and becomes private in R9).
- Add the `t3-no-agents` rule next to `terminal-no-agents` (R9 makes it
  pass).
- `src/panels/runtime.ts` holds only the list of panel runtimes. Its feature
  logic moves to the owning modules: the repository adapter to R3,
  `chatChanges` and the review readiness check to R9.

Done when: the B34 fixtures all fail lint; `npm run lint:deps` passes on
the real tree.

### R3. Trust enforced inside the runtimes that run processes

Problem: trust is checked at capability edges, so in-process callers skip it
(B9); revoke stops nothing (B22).

Change:
- `createRepositoryRuntime` returns a `git` whose methods check trust and a
  `monitors.subscribe` that refuses while untrusted. Keep raw git private to
  the module. `vcsCapabilityImpl` drops its own checks. The review session
  receives this `git` directly; the `mutate` adapter copy in
  `panels/runtime.ts:146-149` goes.
- The same rule for the other process-running runtimes, which already check
  per method: terminal, t3, agents, skills. Move their checks inside the
  runtime if any sit only at the edge.
- Revoke: the composition root's trust listener (`compose/workspace.ts:405`)
  also handles revoke by calling the existing stop functions: terminal
  shutdown of all PTYs, t3 stop of all harnesses, repository monitors stop.
  No new process registry; these three are the only owners of processes.
- Delete the client-facing `server` capability
  (`runtime/daemon/entry.ts:300`, `client/connections/capabilities.ts:33`):
  no client uses it and it lets any paired client start any command. T3
  keeps using `ServerHost` directly.

Doc: sections 7.9, 9.2.
Done when: B9 and B22 tests pass; no `requireTrusted` call remains in a
`*CapabilityImpl`.

### R4. One way to talk to the runtime

Problem: typing into a terminal has four paths (`process.attach` stream
writes; `process.write`, used only by e2e; session ops `input`/`submit`,
called by nobody; `cate.terminal.type`). Chat has an unused `startTurn` op
(`panels/chat/session.ts:156`). The iOS core calls agents through
`api.call` with hand-written types (`shells/mobile/core/cateApi.ts`). Watched
state comes in three shapes. The session channel still has a byte path no
session uses (`panels/framework/runtime/PanelSession.ts:118-140`,
`sessionHost.ts:129`, `capability.ts:32`).

Rules (write them into section 7.8):
1. Clients call typed capabilities and session ops, never `api.call`.
2. The `cate` API serves CLI and harness callers; its handlers call the same
   service functions and session ops clients use, never a second
   implementation.
3. State a client watches is a resumable `channelStream`.
4. One input path per resource.
5. Session channels carry JSON only.

Change:
- Terminal input: the `process.attach` stream. `cate.terminal.type` calls the
  terminal service's write function. Delete `process.write` (update e2e to
  use the attach stream or the CLI), the terminal `input` and `submit` ops
  and `submit()`.
- Delete chat `startTurn`.
- iOS agent calls: add the methods it needs (`start`, `types`, `send`,
  `interrupt`) to the agents capability, calling the same functions as the
  API handlers. Delete `shells/mobile/core/cateApi.ts`.
- Convert to `channelStream` the streams clients watch across reconnects:
  `pairing.watch`, `watchTrust`, `vcs.status`, `watchDownloads`, the
  workspace settings mirror (removes the B13 interim fix). Leave a stream as
  is when nothing resumes it; do not convert for uniformity alone.
- Delete the session byte path (`emitBytes`, `initialBytes`, `bytes: true`,
  `sink.onInput`) and its test.
- Presence: section 7.6 says clients show presence; no client consumes
  `presence.subscribe` outside e2e. Ask the user: show it (a small avatar
  row in both shells) or delete the sentence and the client stream.

Doc: sections 7.8, 10.1, 11.2, 14.
Done when: `grep -rn "api.call" src/shells src/client` is empty; the
deleted ops and methods do not exist.

### R5. One client core entry, and the core sides that are missing

Problem:
- Desktop boot fills about 38 install/register slots by hand
  (`shells/desktop/renderer/boot.ts:133-182`); mobile fills 4
  (`shells/mobile/core/boot.ts:24-47`) and works around the rest:
  `acquireSession` returns null on iOS (`client/host/sessions.ts:50`, no
  `installSessionSource`), `chat.ts` repeats `openUrlFor`'s loopback check,
  `views.ts:63-77` re-implements following a session across reconnects.
- Chat page logic exists twice: `shells/desktop/ui/panels/chat/ChatView.tsx:117-185,262-280`
  and `shells/mobile/core/chat.ts:53-175` (adopted thread, navigation guard,
  dispatcher, follow another client, change summary dedupe).
- Browser tab-follow logic exists twice:
  `shells/desktop/ui/panels/browser/pageHost.ts:165-186,298-300` and
  `shells/mobile/core/browser.ts:47-71`.
- Core logic only in the desktop UI: the trust prompt queue
  (`ui/workspace/lifecycle/trustStore.ts`; iOS never calls `setTrust`),
  file tree and search models (`fileTreeModel.ts`, `searchRunner.ts`,
  `explorerRefresh.ts`), worktree switching (`ui/app/workspace/hosts.tsx:42-85`,
  `ui/client/layout/canvas/actions.ts:19-35`), parallel work discard and
  open PR (`ui/workspace/repository/parallelWork.ts:95-344`,
  `openPullRequest.ts`).
- Network stack assembled per shell (`shells/desktop/main/transports.ts:56`,
  `shells/mobile/core/transports.ts:25`); pairing result to endpoints written
  three times (`client/workspaces/join.ts:30-36`,
  `shells/desktop/renderer/transports.ts:56-62`,
  `shells/mobile/core/transports.ts:41-47`); `NetworkDialEndpoint`
  duplicates `NetworkEndpoint`.
- Electron concepts in core sides: `services/t3/client/webview.ts`
  (partition, `setCookie`), `services/browser/client/index.ts:14-50`
  (partitions, page bridge).

Change:
- `startClientCore(options)` in `client/` (new, replaces two hand-written
  boots). It takes the shell transports, device info, features, and the
  shell's implementations of the ports the core needs (`ClientUi`, device
  store, and the ones that exist today). It installs everything; slots
  become private to the client layer. Delete `installSessionSource`
  (`client/host` imports `client/connections` directly, same layer).
- `panels/chat/client`: one chat page controller (moved from `ChatView`,
  not rewritten) over a page port with exactly the members both shells use
  today. Both shells call it.
- `panels/browser/client`: the tab follower (moved from `pageHost.ts`). Both
  shells call it.
- Move, do not redesign: trust queue to `client/workspaces`; file tree and
  search models to `workspace/files/client`; worktree switching, checkout
  hooks for new panels, discard and open PR flows to
  `workspace/repository/client`; notification gating per R10.
- `runtime/transports/client` builds the network stack and turns a pairing
  result into endpoints once; `ShellTransports` keeps only the raw factories
  (WebSocket, peer connection, mDNS, local pipe) and the desktop's key
  custody. One endpoint type.
- Move webview partition and cookie code to `services/{t3,browser}/desktop`.

Doc: sections 12, 15.
Done when: both boots call `startClientCore` once; `ChatView.tsx` and
`mobile/core/chat.ts` use the same controller; a shared-workspace test
grants trust through the core API that iOS uses.

### R6. Surfaces chosen by feature, not by browser

Problem: the surface broker accepts only `pageDriver` clients for every op
(`panels/framework/runtime/surfaces.ts:50`), so with only iOS connected a
fresh chat's first prompt fails (`no-renderer`); `webview` is declared and
never asked for; the desktop routes by `request.op.startsWith('chat.')`
(`shells/desktop/renderer/webviews.ts:133`); chat and browser views keep
separate module-level registries (`ui/panels/browser/surfaces.ts` `hosts`,
`ui/panels/chat/parts/surfaces.ts` `guests`); mount-on-demand exists only
for the browser; code cells pass a fake panel id
(`panels/browser/runtime.ts:53,70`, `browserPanels()[0] ?? ''`).

Change:
- Each panel definition lists its surface ops and the client feature each
  requires (`chat.sendText: 'webview'`, browser page ops: `'pageDriver'`).
  The broker accepts a client that has at least one required feature and
  picks per op.
- `client/host` keeps one surface registry keyed by panel id; views
  register a handler for their panel; mount-on-demand works for every type.
  Delete the two view registries and the prefix routing.
- Code cells: make the panel id optional on a surface request (any client
  with the feature may answer). Then check `browserCode.call`: if it only
  duplicates this, delete it.

Doc: sections 10.2, 11.2 rule 4, 12.2.
Done when: a shared-workspace test with a client declaring only `webview`
serves `chat.sendText`; no `startsWith('chat.')` remains.

### R7. Persistence through one engine

Every JSON file goes through `kernel/state`: `document.json` (with B7's
epoch and the per-client counters; done in B10), the server pid file
(B3), agents stamps (R9). `grep -rn "writeFileSync\|fs.writeFile\|fs.promises.writeFile" src/`
outside `kernel/state` and log sinks must come back empty, or each
remaining hit gets a one-line reason in a comment.

Also: a corrupt file that `kernel/state` quarantines raises a visible
warning (a notification through R10) naming the file and the quarantine
path. Silent reset to defaults is the only behaviour that changes.

Doc: sections 9.1 (document persisted through `kernel/state`, external
edits picked up), 16.

### R8. Document, canvas, relations, editor file

Problem:
- `workspace/canvas/contract.ts:6` imports document types: the only edge of
  the document/canvas cycle.
- The reducer branches on the type string `'canvas'`
  (`workspace/document/contract/apply.ts:136,206,219,226,262,277`,
  `validate.ts:56`).
- `workspace/relations` holds editor draft rules (`contract/drafts.ts`),
  desktop curve math (`contract/geometry.ts`), and depends on
  `workspace/lifecycle/runtime/gitignore.ts`.
- `relationContextMode` is an undeclared panel field parsed in three places
  (`ui/workspace/relations/actions.ts:8-11,61-72`,
  `services/agents/runtime/promptContext.ts:10`,
  `compose/workspace.ts:472-491`); the desktop toggle recompiles prompt
  context itself.
- An editor's open file is a record field, so undo or another client
  switches a dirty editor's file (B27).

Change:
- Move `CanvasModel` and `CanvasNode` into
  `workspace/document/contract/schema.ts`; `workspace/canvas` becomes pure
  geometry and placement, imported one way.
- The reducer tests record data (a canvas panel's record has `canvasId`)
  instead of the type name.
- Move drafts to `panels/editor/contract`, curve math to `workspace/canvas`,
  `ensureCateGitignore` to `workspace/files` (owner of `.cate/`).
- Declare `relationContextMode` with its parser once in the relations
  contract. The toggle shows the runtime's preview (`promptContext.peek`
  exposed on the agents capability) instead of recompiling.
- The editor's open file becomes session state (snapshot and session file);
  the record keeps the title. `describe` reads the session. This removes
  B27 by construction.

Doc: sections 5, 9.1, 9.3, 9.7, 11.3.
Done when: no document/canvas cycle; `workspace/relations` imports only the
document; `grep "=== 'canvas'" src/workspace` is empty; B27 test passes.

### R9. The agents service is the only owner of agent state

Problem:
- Chat agent state has two owners. `ChatSession.observe()`
  (`panels/chat/session.ts:280-292`) computes `activity`, `agentName`,
  `canReceivePrompt` from T3 thread shells; `t3Runner`
  (`services/agents/runners/t3/t3Runner.ts:83-95,148,158`) computes the same
  from the same shells. `ChatBindings` (`panels/chat/parts/runtime/bindings.ts`)
  copies document state from the session to the runner and calls back into
  the session (`sendFresh`).
- The resume stamp lives in `terminalRunner` memory (`:73,108`) and is
  persisted by `TerminalSession` (`panels/terminal/session.ts:105-111`); it
  is not read back after restart; `runner.resumeStamp()` has no caller.
- `runner` leaks: shells branch on it (desktop
  `ui/services/agents/contextTransport.ts:16`, `panelInfo.ts:18,72`,
  `tabDecorations.tsx:25`; iOS `shells/mobile/core/agents.ts:168-171`,
  which re-implements the runner's own rule from `terminalRunner.ts:276`);
  review branches on `source === 'terminal'` and maps T3 thread ids
  (`panels/review/session.ts:101,589-598`).
- `AgentsRuntime` (`services/agents/runtime/agentsRuntime.ts:52-77`) exposes
  10 internals; `panels/runtime.ts:156-250` reaches into `hooks`,
  `settings`, `promptContext` and holds `chatChanges`.
- `services/t3/contract/providers.ts:4` imports the agents registry
  (t3 and agents import each other).
- `start.ts` holds both runners' launch logic.

Change:
- `PanelAgentState` carries what the views need, computed by the owning
  runner: the fields both views read today plus the prompt context policy
  (`contextPolicy`) that `contextTransport.ts` re-implements. Shells stop
  reading `runner`; it remains only as the creation choice of
  `cate.agent.start`.
- Runners are private to `services/agents/runtime`; each has its own
  `start` (split `start.ts`).
- Chat follows the terminal pattern: the t3 runner reads the chat record's
  `threadId` and `worktreeId` from the document, sends prompts to T3 itself,
  and writes `threadId` into the record when a fresh chat's first prompt
  creates the thread. `ChatSession` keeps harness and page state only. The
  chat view reads agent state from `agents.panels` like the terminal view.
- Agents owns and persists resume stamps (`agents/stamps.json` through
  `kernel/state`); the terminal session gets its launch through the terminal
  service's existing launch-intent extension point and imports no agent
  type.
- Replace the exposed internals with the three calls panels actually make:
  changes for a panel (resolves terminal or thread internally, replaces
  `chatChanges`, `hooks.readChanges/bindChanges` and review's
  `threadIdOf`), readiness for a checkout, and session ended for a panel.
  Review no longer sees `source`, `sourceId` or thread ids.
- t3 owns `T3ProviderId` and its provider table; agents maps agents to
  providers; `t3-no-agents` rule on.

Delete: `ChatBindings`, the chat snapshot agent fields,
`TerminalPersisted.stamp`, `runner.resumeStamp()`, `chatChanges`, the public
members of `AgentsRuntime` beyond the three calls and what the composition
root needs, every `runner` branch outside `services/agents/runtime`.

Doc: sections 2 (Agents), 10.4, 11.3.
Done when: `grep -rn "runner" src/shells src/panels` finds only the
`cate.agent.start` argument; `services/t3` imports nothing from
`services/agents`; e2e `agent-start`, `agent-context`, `agent-changes` pass.

### R10. Notifications out of agents

Problem: the general notification channel is `agents.notifications`:
`cate.ui.notify` publishes into it (`compose/workspace.ts:324-325`), push
subscribes to it (`entry.ts:230`), iOS special-cases
`kind !== 'cate.ui.notify'` (`shells/mobile/core/agents.ts:142`), the
terminal cannot publish without importing agents, and gating
(`ui/app/notifications/{gating,debouncer}.ts`) lives in the desktop UI, so
iOS ignores `notificationsEnabled` and `notifyOnlyWhenUnfocused`.

Change: move the existing event type, publish function and stream out of
agents into `workspace/notifications` (contract, runtime, client). Agents,
the terminal and the API handler publish; push subscribes in the
composition root. Move gating and debounce (as they are) into its client
side; both shells give it a display function. No new event model.

Delete: `agents.notifications`, `attachAgentNotifications`, the desktop
gating/debouncer modules (moved), the iOS special case.

Doc: sections 10.5, 12.2.
Done when: iOS honors `notifyOnlyWhenUnfocused` (core unit test); the
terminal service publishes without importing agents.

### R11. Narrow session kit, one panel kit, one worktree lookup

Problem: `SessionKit` (`panels/framework/runtime/PanelSession.ts:32-41`)
gives every session the whole `DocumentService` and `session(panelId)`
(another panel's session; zero callers). `PanelServices`
(`panels/runtime.ts:40-60`) has 17 fields. Two `PanelKit` implementations
(`panels/definitions.ts:60-89`, `panels/framework/runtime/createPanel.ts:32-80`)
duplicate `numberedTitle`, `uniqueTitle` and the worktree-for-path lookup,
a third copy sits in `panels/editor/session.ts:213`, and seven sessions
compute their checkout path; all differ from
`workspace/repository/contract/worktrees.ts:77` (case folding, orphans).

Change:
- One pure panel kit in `panels/framework/contract`, used by client and
  runtime, calling `worktreeForPath`.
- `SessionKit` keeps what sessions use: record, persist, document `apply`,
  `checkoutPath()`, log. Delete `kit.session`.
- Each panel `runtime.ts` takes exactly the services it uses; delete
  `PanelServices`.

Done when: one definition each of `numberedTitle`, `uniqueTitle` and the
worktree lookup in `src/`.

### R12. Lean contracts

Move helpers that only a runtime side uses out of contract barrels:
`codexTrustedHash`, `normalizeAgentHookPayload` (agents),
`enforceCateSettings`, `isProviderSecretFile`, `applyT3ShellEvent` (t3),
`threeWayMerge` (files). Check each with a grep before moving. Delete
unused exports (`ACCENT_PALETTE`, `NodePopover`, `SkillsRegistry`,
`SnapshotOf`, `ChangeOf`, `OpOf`, `ChannelOp`, `SnapshotOfPanel`,
`OpOfPanel`, `DocChangeKind`, `StatusEvent`, `InstallLayout`,
`BrowserElementTarget`, `ReviewDiffResult`, `TerminalFields`, `ChatFields`,
`BrowserRecordFields`) and production exports used only by their own tests
(`lastAssistantText`, `agentForSkillTarget`, `mergeT3ShellSnapshot`,
`recommendPlacementFromSource`, `classifyExternalEvent`,
`editorDraftDirectory`, `panelConnectionAnchor`,
`isPanelRelationSourceAnchored`, `serializeDocument`, `isPrereleaseVersion`,
`openPushMessage`, `nullSink`), after confirming each with a grep.

Other cleanup in the same pass:
- Delete `shells/desktop/ui/client/layout/drag/shellLogic.ts` (dead copy of
  main's logic) and its test.
- Delete the module-level `lifecycle` singleton
  (`kernel/lifecycle/runtime/index.ts`); make the `RpcServer` option
  required (both callers already pass it).
- Review: delete `revealPanel` and `placeNear` in
  `panels/review/client/openReview.ts` and use `client/host`'s
  `revealPanel` and `createPanel(..., {near})`; `GitReviewView.tsx:302-307`
  uses `createPanel`. Chat's `openChanges` (`panels/chat/session.ts:172-183`)
  and `openAgentChanges` become one path in `panels/review/client` with
  typed `ReviewCreateOptions`; review binds changes itself.
- Move test helpers into `src/test/`: `workspace/document/contract/fuzz.ts`,
  `workspace/repository/runtime/testGit.ts`,
  `kernel/interaction/testing.ts`, `ui/workspace/skills/testRuntime.ts`,
  `renderer/testing.ts`.
- `runtimeFor` is installed once by `startClientCore`, not by the
  `WorkspaceConnections` constructor (last instance wins today).

### R13. Compatibility by protocol version

Problem: `client/connections/connection.ts:218` marks a runtime with a
different build hash as incompatible, and the build is a hash of `src/`.
The App Store iOS app and every teammate's desktop must match exactly, and
clients on different builds push the runtime back and forth with
`runtime.update`, killing the other client's terminals.

Change: compatibility is the protocol major version (section 7.8); a minor
difference connects. The build is used only by the desktop to restart a
stale runtime on its own machine (`runtime:dev` and installs). A client
never updates a runtime other clients are connected to without asking the
user.

Doc: sections 7.8, 7.10.
Done when: a shared-workspace test connects a client whose build differs
but protocol matches; a protocol major mismatch shows `incompatible`.

---

## Part 4: Order

Each step leaves typecheck, lint, lint:deps and the test suite green.

| Step | Items | Notes |
|---|---|---|
| 1 | B34 (lint ignores and depcruise fixtures), B32 | Truthful checks before anything else |
| 2 | B1-B11 | P0; B8 stops before deploying cate-connect; B9 includes R3's repository part; B10 includes the `document.json` move of R7 |
| 3 | B12-B31 | P1; B22 and B27 are fixed by R3 and R8, so write their tests now and mark them `it.fails` until then |
| 4 | R2, R1 | Dependency rules and a feature-free kernel |
| 5 | R3, R7 | Trust and persistence |
| 6 | R4, R6 | Protocol rules and surfaces |
| 7 | R5 | Client core entry and missing core sides |
| 8 | R9, R10 | Agents and notifications (ask about the uncommitted agents UI edits first) |
| 9 | R8, R11, R12 | Document, kits, contracts, cleanup |
| 10 | R13 | Before the iOS app ships |
| 11 | B33 | Network hardening |

When done, update `docs/architecture.md` where any step changed the model
(each item names its sections), and rerun the two reviews: the
architecture is clean when every feature in the boundary review reads
"clean": terminal, editor, skills, open workspace, pairing, agents,
notifications, settings, canvas and relations, browser, chat, review,
worktrees.
