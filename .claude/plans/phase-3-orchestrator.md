# Phase 3 — AI Orchestrator Node

## Context

Phase 1 (polish batch) and Phase 2 (AI Config authoring UI) have shipped to `main`. This document is the project brief for Phase 3: a first-class **AI Orchestrator** canvas panel that coordinates multiple CLI agents and worker terminals, with a kanban board and an MCP-based control plane.

Keep it narrow per sub-phase — each `3a`–`3d` should be able to land as its own PR.

## Goal

A canvas panel dedicated to AI coordination — not a chat box, an orchestration surface. The orchestrator can dispatch work to other terminal panels on the canvas, track progress via a kanban, and keep context windows small across long autonomous sessions.

## Shape

- **CLI agent inside the node.** Runs Claude Code, Codex, or a BYO (bring-your-own) agent via a configurable command. Same PTY plumbing terminals use today (`src/main/ipc/terminal.ts`) but hosted in a new panel type.
- **Kanban board.** Columns: Backlog / In-Progress / Review / Done. Tasks are work items any terminal on the canvas can pick up, edit, or complete. Selection flows through the orchestrator.
- **Cross-terminal control via MCP.** The orchestrator exposes an MCP server. Worker terminals (also running CLI agents) connect to it. The orchestrator dispatches tasks and reads worker output.
- **Event / heartbeat driven.** Workers emit heartbeats and status events; orchestrator reacts without polling. Enables long-running autonomous coding sessions.
- **Context-minimal tool design.** MCP tools expose *names + short descriptions* by default. The agent pulls detail only when calling a tool (progressive disclosure). Keeps context windows small across multi-hour sessions.
- **Usable as an MCP server inside the editor**, too — so an agent in an editor panel can see and claim kanban tasks without needing the orchestrator window open.

## Dependencies (already on main)

- `src/main/ipc/mcp.ts` — MCP server spawn infra, `mcpTest` probe that returns capabilities (PR #13).
- `src/renderer/stores/aiConfigStore.ts` — `addMcpServer` / `updateMcpServer` / `spawnMcpServer` / `testMcpServer`.
- `src/renderer/dialogs/MCPServerEditor.tsx` — the editor modal we can reuse for orchestrator-owned MCP server entries.
- `src/renderer/stores/statusStore.ts` — agent state, listening ports, CWD per terminal.
- `src/renderer/panels/TerminalPanel.tsx` + `terminalRegistry` — PTY + xterm lifecycle for workers.
- `src/renderer/canvas/*` — canvas regions (board columns could render as a region variant).

## Decisions (user-confirmed)

- **Orchestrator v1 scope: full vision.** Multi-agent, heartbeat-driven workers, BYO agent shim, cross-terminal MCP control, kanban. Accept the longer runway.
- **Progressive tool disclosure** is non-negotiable — names+descriptions by default, detail on demand.

## Open (resolve per sub-phase)

- **Kanban board scope:** per-workspace (one board) vs per-region (multiple boards on one canvas). Start per-workspace in 3a; revisit if users ask for sharded boards.
- **BYO agent contract:** stdio MCP shim vs arbitrary binary + user-provided wrapper. Likely stdio MCP shim for 3d.
- **AI Config UI template source** (carried over from Phase 2): in-repo curated vs remote manifest. Defer until we have real orchestrator users to inform the call.

## Decomposition

### 3a — Panel shell + single CLI agent + kanban board rendering

Scope:
- New panel type `orchestrator` (extends `PanelType` in `src/shared/types.ts`).
- Renders: top row for agent I/O (PTY + xterm), bottom for kanban (or split layout with DockTabStack reuse).
- Kanban: in-memory store (`orchestratorStore.ts`), columns backed by arrays, tasks with id/title/description/status/assignee (initially `'unassigned'`).
- Single CLI agent runs inside the node using the existing terminal infra (scoped PTY; reuse `terminalRegistry` with a `'orchestrator'` flag to differentiate lifecycle).
- No worker coordination yet — just the shell so the UX can be evaluated.

Verification: create an orchestrator panel, talk to the inline agent, manually add/move tasks on the board, persist across canvas switch.

### 3b — MCP server exposed by orchestrator + worker registration

Scope:
- Orchestrator spawns its own MCP server (stdio) advertising tools: `list_tasks`, `claim_task`, `update_status`, `complete_task`, `post_message`.
- Worker terminals (agents) register themselves via a known tool (`register_worker(name, capabilities)`).
- `statusStore` extended to track registered workers per orchestrator.
- UI: kanban tasks can be dragged onto a worker; the claim shows worker name on the card.

Reused: the Phase 2 `mcpTest` capability probe is useful for health-checking worker connections.

Verification: run orchestrator + two terminals manually registered via `register_worker`; dispatch a task; worker picks it up and reports back.

### 3c — Heartbeat/event protocol + autonomous loops + progressive disclosure

Scope:
- Workers emit heartbeats (`tick` event every N seconds). Missing heartbeats mark worker `stale`.
- Orchestrator exposes an event stream tool workers can subscribe to (`stream_events`).
- **Progressive tool disclosure:** default tool surface = list of `{ name, one-line-description }`. Detail only on `describe_tool(name)`. Enforced at the MCP level so every client sees the slim surface first.
- Autonomous loop: orchestrator agent can mark `auto=true` on a task; workers self-assign based on capability match.

Verification: leave a session running with auto tasks; confirm workers keep picking up work without orchestrator intervention; context-window usage stays bounded.

### 3d — BYO agent shim + template presets

Scope:
- Shim that wraps an arbitrary CLI command to speak the orchestrator's MCP protocol (stdio in/out). Users can point the orchestrator at any agent binary.
- Bundled presets for Claude Code, Codex, Gemini CLI, OpenCode. Reuses the Phase 2 template-library concept (if not already built by then).
- Config lives in `.cate/orchestrator.json` alongside `.mcp.json`, writable through the existing `pathValidation` pipeline.

Verification: configure a non-Claude agent (e.g. Codex) as a worker via the shim; orchestrator dispatches a task; agent completes it and closes the card.

## Out of scope

- Shared LSP across editor panels (separate effort).
- Multiplayer / VM-hosted Cate (parked; revisit after Phase 3 ships).
- Cloud persistence of kanban state — local only for v1.
- Notifications / native alerts on worker events — log in-app only for now.

## Verification (whole phase)

Each sub-phase gets its own PR with its own acceptance checklist. End-to-end acceptance for Phase 3:

1. `npm run dev`, create an orchestrator panel.
2. Start two terminal workers that register via `register_worker`.
3. Orchestrator agent creates three kanban tasks from user prompt.
4. Dispatch to workers; one completes, one fails; orchestrator handles both paths.
5. Close and reopen the workspace — kanban state restores; workers reconnect.
6. Context-window usage on the orchestrator stays under a configurable budget over a 30-minute autonomous run (measured via the existing usage store).

## References

- Phase 1 / 2 review + brainstorm (where these decisions were captured): `~/.claude/plans/review-current-app-status-frolicking-journal.md` (kept as personal notes, not committed).
- Phase 2 PR landing the MCP validate probe + server editor: #13.
