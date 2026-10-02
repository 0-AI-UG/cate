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
| Hermes | Preserve `surface` through the managed plugin. `cli` confirms the local human prompt; `smart`, custom transports, and missing/unknown surfaces are checks. `post_approval_response` resumes either path. |
| Grok | `Notification` with `permission_prompt` confirms a human prompt. Ordinary pre-tool hooks do not. |
| OpenCode | `permission.asked` and `permission.replied` delimit a pending permission request. Automatically allowed tools do not create this wait. |
| Cursor / Kiro | Their current hooks do not distinguish a human permission prompt from ordinary tool checks. Keep the turn running; do not manufacture an attention notification. |

Settings → Agents → Hooks shows a read-only Codex label: **Approvals:
Automatic / Manual / Unknown**. There are no approval overrides and Cate never
modifies the CLI's permission policy.

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
`runners/terminal/terminalRunner.test.ts` exercises ordered hook/PTY delivery;
`runtime/hooks/hermes.test.ts` executes the generated Python bridge when Python
is installed; the live Claude contract (`runtime/agentHookContracts.itest.ts`)
verifies the human permission notification against the installed CLI.
