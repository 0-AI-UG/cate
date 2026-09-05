# Provider identities and execution integrations

`src/shared/agents.ts` is the canonical provider registry. Its CLI fields describe
terminal execution; its optional `t3` field maps the same identity to the pinned
T3 provider/driver ids. `TERMINAL_AGENTS` and `T3_AGENTS` filter that registry.
Provider presence, configuration, authentication and runtime readiness are not
shared state between the two integrations.

Terminal skill installation targets remain attached to provider identities.
Installing a provider's project skills once is sufficient for integrations that
consume those same files. Cate does not create duplicate T3 skill directories or
claim that T3 exposes every skill supported by a provider's interactive CLI.
Custom T3 home/environment settings can affect discovery; T3 owns that discovery.

## Current capability boundaries (T3 0.0.38)

| Capability | Terminal CLI | T3 Code |
| --- | --- | --- |
| Launch | Provider executable in a Cate PTY | Provider managed by T3 |
| Auto title | CLI session metadata/OSC | Structured thread title; user rename wins |
| Activity | Process presence and hooks | Shell subscription, keyed by runtime/checkout and thread id |
| Approval/input | CLI hook support varies | Pending approvals/input/plan from T3 |
| Background work | CLI hooks/process tracking | T3 background liveness, including monitoring |
| Stop/interrupt | Cate terminal-worker commands | T3 conversation controls |
| Restore | CLI resume support varies | Saved T3 thread id and persistent harness home |
| Worktree switch | Fresh terminal | Fresh conversation binding in selected checkout |
| Review launches | Cate-owned terminal worker | Not exposed as a review destination |
| `cate agent` commands | Terminal workers, explicitly identified in snapshots | Not a T3 conversation API |
| Skill installation | Shared provider skill target | Same files where the T3 driver supports discovery; no separate install target |

One Cate T3 panel binds to one conversation. Several panels may share a harness.
The toolbar conversation popup searches saved chats in the checkout inherited
from canvas selection, using the same context as terminal creation. There is no
separate worktree selector or T3 activity-bar sidebar.
Selecting a chat (or New conversation) starts Cate’s panel-placement flow.
The embedded T3 sidebar is hidden; panels cannot navigate to another chat.
The guest subscribes to T3's authenticated `orchestration.subscribeShell` stream;
only title/activity metadata crosses into Cate, not messages. Hidden panels remain
mounted. All conversations in the shell snapshot are tracked separately, including
background conversations. Panel indicators resolve only their bound thread.
Detached windows publish that same resolved state through the panel-report path.
A disconnected subscription reports unknown activity and reconnects from a full
snapshot; a running server is never treated as a running conversation.

Hook injection settings live under Terminal. T3 Code settings configure T3-owned
provider instances with Cate's shared settings controls. Internal `agent` panel
ids and existing `cate agent` command names remain compatible with saved layouts
and scripts. Those names do not imply a common session-control protocol.

Command+K offers new T3 conversations and existing local/other-window panels.
T3 participates in the shared split menu, and selecting it restores guest focus
after the palette closes. The conversation popup supports confirmed deletion
through T3's authenticated thread.delete command; ordinary panel close preserves
the saved conversation.
