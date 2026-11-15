# Terminal agent activity

Approval requests do not imply that the user needs to respond. Cate normalizes
them separately from confirmed human prompts:

- `permission-check` stays `running` unless Codex's resolved configuration
  specifies manual approvals. Manual mode displays
  `waitingForInput` and sends a permission notification.
- `permission-wait` → `waitingForInput` (human permission notification, still
  cannot receive a new addressed prompt).
- Tool activity or an approval response resumes the turn. Turn completion
  returns to the normal input prompt.

| CLI | Approval evidence |
| --- | --- |
| Codex | `PermissionRequest` runs before reviewer routing. Its `permission_mode` cannot distinguish automatic review from a human prompt. Cate reads resolved configuration through the host's Codex `config/read` API. |
| Claude Code | `PermissionRequest` is a check; `Notification` with `permission_prompt` confirms a human prompt. Claude delays that notification by about six seconds. Automatic denials and failed tools resume via `PermissionDenied` and `PostToolUseFailure`. |
| Grok | `Notification` with `permission_prompt` confirms a human prompt. Ordinary pre-tool hooks do not. |
| OpenCode | `permission.asked` and `permission.replied` delimit a pending permission request. Automatically allowed tools do not create this wait. |
| Pi | `ui_prompt_start` / `ui_prompt_end` delimit blocking extension dialogs. Built-in tools run without approval prompts. `agent_settled` is final idle; individual model turns and retries do not mark completion. Manual compaction stays Running until its success/failure event. |
| Cursor / Kiro | Their current hooks do not distinguish a human permission prompt from ordinary tool checks. Keep the turn running; do not manufacture an attention notification. |

Settings → Agents → Codex settings shows a read-only label: **Approvals:
Automatic / Manual / Unknown**. There are no approval overrides and Cate never
modifies the CLI's permission policy.

Codex hook trust is separate from tool approvals and Cate's integration toggle.
The runtime reads Codex's `hooks/list` API to inspect only Cate's project hooks.
Untrusted or modified hooks show **Hooks need approval** in Settings and Threads,
with instructions to review them in Codex's `/hooks` menu. Unsupported or failed
inspection stays unknown. Cate never grants trust or writes Codex's trust state.
Silent terminal agents are rechecked at most once every 15 seconds; a received
lifecycle hook supersedes the warning. Trust alone never proves idle or busy.

For Codex, `approvals_reviewer = auto_review` (or `guardian_subagent`) and
`approval_policy = never` mean automatic. The default `user` reviewer means
manual. Unknown/read failures stay Running without an attention notification.
Inspection runs in the workspace's runtime (`services/agents/runtime/hooks/
approvalConfig.ts`) with the workspace directory and the terminal's
environment, caches results for 30 seconds, and can be refreshed from
Settings. Only approval metadata leaves the runtime. Input and hooks retain
their delivery order while config inspection is pending.

Launch flags, selected profiles, and in-session changes can differ from the
inspected configuration.
Configuration is a fallback, not proof of who handles an individual request:
custom hooks or automatic-review fallback can still behave differently. Codex's
experimental `item/autoApprovalReview/started` and `completed` app-server events
are not delivered to terminal hooks. This is not a universal 100% classification
guarantee. Completion remains driven by turn-end/session-end/process exit, never
by approval configuration, and permission checks cannot accept addressed prompts.

Child-agent lifecycle hooks must not announce the parent terminal as ready.
Claude/Codex payloads marked with `agent_id` are excluded from activity
normalization, while raw change ingestion remains available. Session and turn
identity guards in the runtime's status machine reject stale completion and
approval events.

Regression coverage (`src/services/agents/`): `runtime/status.integration.test.ts`
covers all registered CLIs and notification behavior;
`runtime/terminal.test.ts` exercises ordered hook/PTY delivery; the
fake-provider lifecycle suite
(`runtime/live/hookLifecycle.itest.ts`) verifies the human permission
notification against each installed CLI.


On terminal restoration, a Codex resume without an initial prompt opens its
normal input prompt, but Codex defers SessionStart until the next submission.
Cate seeds Ready only for a deliberately restored panel with a matching saved
checkout binding, after the exact live CLI process confirms that it opened the
requested saved session. A process name or an unrelated discovered session does
not establish readiness. The seed emits no completion notification and never
overrides a hook event; subsequent turns and permissions remain hook-driven.

In Threads view, the desktop reconnects remembered local workspaces in the
background so their threads remain visible after restarting Cate. Background
observation never selects a workspace or asks for or grants trust. Untrusted
workspaces disconnect; explicitly selecting one uses the normal trust flow.
Remote workspaces connect only when opened explicitly.
