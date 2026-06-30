# Cate Agent redesign — design

Date: 2026-06-15
Status: Approved for planning

## Summary

Redesign the Cate Agent ("pet layer") interaction surface. Replace the
free-floating corner avatar and the sidebar Tasks list with a single,
toolbar-anchored experience:

- The agent's entry point becomes a button at the left of the bottom-center
  canvas toolbar.
- Clicking it turns the toolbar into a prompt input bar.
- All agent output — status, remarks, proposed todos (with inline approval) and
  running-task progress — renders in a feedback panel docked directly above the
  toolbar, the same width as the input bar.
- When the executor is actively driving a terminal, that terminal node gets a
  slow-pulsing glowing border in the agent accent color.

Persistence (`.cate/todos.json`, `.cate/cateAgent.json`) and the controller /
session / bridge / tools machinery are unchanged except where noted. This is a
presentation-layer redesign plus one new user-initiated prompt path.

## Goals

1. Move the agent entry point from a draggable corner avatar to the left edge of
   `CanvasToolbar`.
2. Toggle the toolbar between its normal tool buttons and an agent prompt input
   bar (text input + send button).
3. Render all agent output in a feedback panel above the toolbar, same width as
   the input bar, including inline todo approval.
4. Remove `TasksView` from the sidebar; todos render in the feedback panel.
5. Add a slow-pulsing accent-color glow to terminal nodes the executor is
   actively controlling.

## Non-goals

- Changing how todos are persisted or the todo lifecycle/status model.
- Changing the observer/executor controller loops, the headless session model,
  the bridge, or the tool handlers (other than recording which terminals are
  under active control, and accepting a user prompt).
- Changing the minimap or other toolbar tools' behavior (beyond reflowing them
  when input mode is active).
- Per-workspace accent color for the glow (we use the global `--agent-rgb`
  token).

## Current state (reference)

- `src/renderer/cateAgent/CateAgentAvatar.tsx` — corner avatar, draggable,
  speech-bubble stack, click handlers. **Removed/replaced.**
- `src/renderer/canvas/CanvasToolbar.tsx` — bottom-center floating toolbar with
  mode/create/zoom/minimap controls. **Gains agent button + input mode.**
- `src/renderer/sidebar/TasksView.tsx` — sidebar todo list grouped by status.
  **Removed from sidebar.** Logic for rendering/acting on todos is reused by the
  feedback panel where practical.
- `src/renderer/cateAgent/cateAgentStore.ts` — per-workspace live state
  (activity, status, remarks, currentTodoId). **Gains controlled-terminal set +
  feedback/input UI state.**
- `src/renderer/stores/todosStore.ts` — per-root todos. **Unchanged.**
- `src/renderer/cateAgent/cateAgentController.ts` — observer + executor loops.
  **Gains: set/clear controlled-terminal ids around executor terminal work; a
  `prompt(userText)` entry path.**
- `src/renderer/cateAgent/cateAgentTools.ts` — tool handlers incl. terminal
  create/read/send/close, `setRemark`, todo tools. **`setRemark` output now also
  feeds the feedback panel; terminal send/read mark control state.**
- `src/renderer/panels/TerminalPanel.tsx` / `canvas/CanvasNode.tsx` — terminal
  rendering. **Consumes controlled-terminal state to render the glow.**
- `src/renderer/App.tsx` — renders `<CateAgentAvatar />`. **Stops rendering it.**
- Theme tokens: `--agent-rgb`, `--agent-light-rgb` (`globals.css`,
  `shared/themes/base.ts`). **Reused for the glow.**

## Design

### Component model

```
CanvasToolbar
├── CateAgentToolbarButton        (always leftmost; activity-state colored/pulsing; toggles input mode)
├── (default mode) existing tool buttons: mode / create / zoom / minimap
└── (input mode)   CateAgentInputBar: <text input> + <send button>

CateAgentFeedback                  (docked above the toolbar, width-matched to it)
├── status line                    (activity + status text)
├── remark / message entries       (agent remarks, replies, run progress; newest at bottom; scrollable)
└── proposed-todo entries          (title + note + [Approve] [Dismiss])
```

`CateAgentFeedback` and the toolbar are positioned as a single bottom-center
stack so the feedback panel always matches the toolbar/input width. The simplest
implementation is to render `CateAgentFeedback` as a sibling within the same
fixed bottom-center container that holds `CanvasToolbar`, with the feedback panel
above and width driven by the same container.

### State (cateAgentStore additions)

Add to `CateAgentWsState`:

- `inputOpen: boolean` — whether the toolbar is in input mode and feedback is
  forced visible. Toggled by the agent button / `Esc` / sending.
- `controlledTerminalIds: string[]` — panelIds of terminals the executor is
  actively driving. Set when the executor begins terminal work for a run and
  cleared on run end / error / dispose.
- Messages feed: reuse existing `remarks` for transient lines, but the feedback
  panel renders a combined, persistent-per-session list. Add a
  `feed: CateAgentFeedItem[]` (id, kind: 'status' | 'remark' | 'reply' |
  'progress', text, ts) capped to a reasonable length (e.g. last 50). Proposed
  todos are read from `todosStore` (status === 'suggested'), not duplicated into
  the feed.

Visibility rule: the feedback panel shows when `inputOpen` is true **or** there
is at least one feed item or suggested todo for the workspace; otherwise hidden.

### Interactions

- **Open input:** click the agent button → `inputOpen = true`, toolbar shows the
  input bar, feedback panel visible. Input gets focus.
- **Send:** Enter or send button → push the user's text to the controller's new
  `prompt(text)` path, append a 'reply' placeholder/progress entry to the feed,
  clear the input. Input stays open.
- **Close input:** agent button again, or `Esc` while input focused →
  `inputOpen = false`; toolbar returns to normal tools; feedback panel follows
  the visibility rule.
- **Approve todo:** in a suggested-todo entry, Approve → `setTodoStatus(pending)`
  (same effect as today's approve), then the existing run path. Dismiss →
  `setTodoStatus(discarded)`.
- **Idle click behavior:** today clicking the idle avatar triggers
  `observeNow()`. We keep manual observe available — the empty input bar with a
  hint, plus sending a prompt, supersedes the old click-to-observe. (Auto-observe
  is unchanged and still gated by settings.)

### User prompt path (controller)

Add `cateAgentController.prompt(workspaceId, text)`:

- Ensures/creates a session for user-initiated turns. Reuse the executor session
  shape but seeded by the user's text rather than a todo. Simplest approach:
  create an ephemeral "user" session (panelId e.g. `cate-agent-user:{wsId}`)
  using the existing `createCateAgentSession` + `promptCateAgent` wrappers with
  the executor role/system prompt, so the same tools (propose_todo,
  create_terminal, etc.) are available.
- Agent replies and remarks surface in the feed via the bridge/tools (see below);
  proposed todos appear as suggested todos rendered inline.

This reuses the existing bridge/tool fulfillment; no new tool protocol.

### Feed wiring (bridge / tools)

- `setRemark()` in `cateAgentTools.ts` continues to set transient remarks **and**
  appends a 'remark' feed item.
- Run lifecycle (`onRunStart`/`onRunEnd`/`onError` via the bridge) appends
  'status'/'progress' feed entries so the user sees activity in the feedback
  panel.
- Agent text output, where available from the session/bridge events, appends a
  'reply' feed item; if reply text isn't readily available from current events,
  we surface run progress + remarks only (acceptable v1).

### Terminal control glow

- When the executor begins driving a terminal node (first `send_keys`/`read`
  loop, or when terminals are opened for a running todo), add those panelIds to
  `controlledTerminalIds`. Clear them on `onRunEnd`/`onError`/dispose.
- `TerminalPanel`/`CanvasNode` subscribes to whether its panelId is in
  `controlledTerminalIds` and applies a CSS class with a slow keyframe pulse on
  `box-shadow`/`border` using `rgb(var(--agent-rgb))`. Pulse: ~2–3s ease-in-out,
  infinite, clearly visible (e.g. glow radius ramps between ~4px and ~16px).
- The class lives in `globals.css` (keyframes) consistent with existing avatar
  animations.

## Error handling

- Sending a prompt while no workspace/root is active: ignore (input disabled when
  there's no active workspace), or show a single feed line "Open a project
  first." Prefer disabling the input.
- Controller `prompt` failures (`onError`) append an error feed entry and clear
  controlled-terminal glow.
- Removing `TasksView` must not break the sidebar registry; the sidebar tab/entry
  for Tasks is removed cleanly (and any keyboard shortcut / command-palette entry
  pointing at it).

## Testing

- `cateAgentStore`: input toggle, feed append + cap, controlled-terminal add/clear,
  visibility rule.
- Feedback panel rendering: shows suggested todos with Approve/Dismiss; Approve
  → status pending, Dismiss → discarded (mock todosStore).
- Toolbar: agent button toggles input mode; Esc closes; send calls
  `controller.prompt` with trimmed text and clears input.
- Terminal glow: node with panelId in `controlledTerminalIds` gets the glow
  class; removing the id removes it.
- Controller `prompt`: creates/uses a user session and prompts it (mock session
  wrappers).

## Migration / cleanup

- Delete `CateAgentAvatar.tsx` and its usage in `App.tsx`.
- Remove `TasksView` from the sidebar registration; delete the file if nothing
  else references it, otherwise repurpose its row/group rendering for the
  feedback panel.
- Remove the avatar↔minimap corner-negotiation logic that's no longer needed
  (the agent button is in the toolbar now); keep the minimap corner pill.
