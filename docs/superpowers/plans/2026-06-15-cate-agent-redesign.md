# Cate Agent Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cate Agent's corner avatar and sidebar Tasks list with a toolbar-anchored experience: an agent button on the toolbar that toggles the toolbar into a prompt input bar, a feedback panel above the toolbar showing all agent output and inline todo approval, and a slow-pulsing accent glow on terminals the executor is driving.

**Architecture:** This is mostly a presentation-layer change plus one new user-initiated prompt path. Live UI state moves into `cateAgentStore` (input toggle, a capped message feed, the set of controlled-terminal ids). The user prompt routes through the EXISTING always-on observer session (which can `remark` + `propose_todo`), so no new session/tool protocol is introduced. Todos still persist to `.cate/todos.json` unchanged. The terminal glow is rendered inside `TerminalPanel` (works whether the terminal is on the canvas or docked) keyed off `controlledTerminalIds`.

**Tech Stack:** Electron + React 18 + TypeScript, Zustand stores, Tailwind CSS, Vitest (`.test.ts` → node env, `.test.tsx` → jsdom). `@phosphor-icons/react` for icons. No `@testing-library/react` is installed — component behavior is verified by typecheck + manual run; pure store/logic is unit-tested in `.test.ts`.

---

## File Structure

**Modified:**
- `src/renderer/cateAgent/cateAgentStore.ts` — add `inputOpen`, `feed`, `controlledTerminalIds` to state; add actions + a `useTerminalControlled` hook.
- `src/renderer/cateAgent/cateAgentTools.ts` — `setRemark` also appends to the feed; `create_terminal` (executor) marks its terminal controlled; `close_terminal` unmarks.
- `src/renderer/cateAgent/cateAgentController.ts` — clear controlled terminals on executor finalize; append a feed line when an executor starts and on error; add `prompt(wsId, rootPath, text)`.
- `src/renderer/canvas/CanvasToolbar.tsx` — add the agent button (leftmost) + input mode; render `CateAgentFeedback` above the toolbar; remove the avatar↔minimap corner-swap.
- `src/renderer/panels/TerminalPanel.tsx` — render the control glow overlay.
- `src/renderer/styles/globals.css` — add the glow keyframes + class.
- `src/renderer/App.tsx` — stop rendering `<CateAgentAvatar />`.
- `src/renderer/sidebar/Sidebar.tsx` — remove the `tasks` view (import, `VIEW_META` entry, switch case).
- `src/renderer/stores/uiStore.ts` — remove `'tasks'` from `ALL_VIEWS`.
- `src/shared/types.ts` — remove `'tasks'` from the `SidebarView` union.

**Created:**
- `src/renderer/cateAgent/CateAgentFeedback.tsx` — the feedback panel (status/feed + suggested-todo rows with Approve/Dismiss).
- `src/renderer/cateAgent/CateAgentInputBar.tsx` — the toolbar's prompt input + send.
- `src/renderer/cateAgent/CateAgentToolbarButton.tsx` — the activity-colored agent toggle button.
- `src/renderer/cateAgent/cateAgentStore.test.ts` — store unit tests.

**Deleted:**
- `src/renderer/cateAgent/CateAgentAvatar.tsx` — replaced by the toolbar button + feedback panel.
- `src/renderer/sidebar/TasksView.tsx` — replaced by the feedback panel.

---

## Task 1: Store — input toggle, message feed, controlled terminals

**Files:**
- Modify: `src/renderer/cateAgent/cateAgentStore.ts`
- Test: `src/renderer/cateAgent/cateAgentStore.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/cateAgent/cateAgentStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useCateAgentStore, DEFAULT_CATE_AGENT_WS } from './cateAgentStore'

const WS = 'ws-1'

describe('cateAgentStore — feedback + control state', () => {
  beforeEach(() => {
    useCateAgentStore.setState({ byWs: {} })
  })

  it('defaults include inputOpen=false, empty feed and controlled terminals', () => {
    expect(DEFAULT_CATE_AGENT_WS.inputOpen).toBe(false)
    expect(DEFAULT_CATE_AGENT_WS.feed).toEqual([])
    expect(DEFAULT_CATE_AGENT_WS.controlledTerminalIds).toEqual([])
  })

  it('setInputOpen toggles per workspace', () => {
    useCateAgentStore.getState().setInputOpen(WS, true)
    expect(useCateAgentStore.getState().get(WS).inputOpen).toBe(true)
    useCateAgentStore.getState().setInputOpen(WS, false)
    expect(useCateAgentStore.getState().get(WS).inputOpen).toBe(false)
  })

  it('appendFeed adds items newest-last and caps at 50', () => {
    for (let i = 0; i < 55; i++) useCateAgentStore.getState().appendFeed(WS, 'agent', `m${i}`)
    const feed = useCateAgentStore.getState().get(WS).feed
    expect(feed.length).toBe(50)
    expect(feed[0].text).toBe('m5') // oldest 5 dropped
    expect(feed[feed.length - 1].text).toBe('m54')
    expect(feed[feed.length - 1].kind).toBe('agent')
  })

  it('clearFeed empties the feed', () => {
    useCateAgentStore.getState().appendFeed(WS, 'user', 'hi')
    useCateAgentStore.getState().clearFeed(WS)
    expect(useCateAgentStore.getState().get(WS).feed).toEqual([])
  })

  it('addControlledTerminal is idempotent; removeControlledTerminal removes one', () => {
    const s = useCateAgentStore.getState()
    s.addControlledTerminal(WS, 'p1')
    s.addControlledTerminal(WS, 'p1')
    s.addControlledTerminal(WS, 'p2')
    expect(useCateAgentStore.getState().get(WS).controlledTerminalIds).toEqual(['p1', 'p2'])
    s.removeControlledTerminal(WS, 'p1')
    expect(useCateAgentStore.getState().get(WS).controlledTerminalIds).toEqual(['p2'])
  })

  it('clearControlledTerminals empties the set', () => {
    useCateAgentStore.getState().addControlledTerminal(WS, 'p1')
    useCateAgentStore.getState().clearControlledTerminals(WS)
    expect(useCateAgentStore.getState().get(WS).controlledTerminalIds).toEqual([])
  })

  it('reset restores all new fields to defaults', () => {
    const s = useCateAgentStore.getState()
    s.setInputOpen(WS, true)
    s.appendFeed(WS, 'agent', 'x')
    s.addControlledTerminal(WS, 'p1')
    s.reset(WS)
    const after = useCateAgentStore.getState().get(WS)
    expect(after.inputOpen).toBe(false)
    expect(after.feed).toEqual([])
    expect(after.controlledTerminalIds).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/cateAgent/cateAgentStore.test.ts`
Expected: FAIL — `inputOpen`/`feed`/`controlledTerminalIds` and the new actions don't exist yet.

- [ ] **Step 3: Implement the store additions**

In `src/renderer/cateAgent/cateAgentStore.ts`, add the feed item type after the `CateAgentRemark` interface (after line 19):

```ts
/** One entry in the Cate Agent's persistent-per-session feedback log (rendered in
 *  the feedback panel above the toolbar). Unlike `remarks` (ephemeral bubbles),
 *  feed items stay until the feed is cleared or rolls past the cap. */
export type CateAgentFeedKind = 'user' | 'agent' | 'status' | 'error'

export interface CateAgentFeedItem {
  id: number
  kind: CateAgentFeedKind
  text: string
  ts: number
}

let feedSeq = 0
const MAX_FEED = 50
```

Add three fields to `CateAgentWsState` (after `currentTodoId` on line 34):

```ts
  /** Whether the toolbar is showing the prompt input bar (and the feedback panel
   *  is forced visible). */
  inputOpen: boolean
  /** Persistent-per-session feedback log shown above the toolbar, newest last. */
  feed: CateAgentFeedItem[]
  /** panelIds of terminals the executor is actively driving — drives the glow. */
  controlledTerminalIds: string[]
```

Add them to `DEFAULT_CATE_AGENT_WS` (after `currentTodoId: null,` on line 43):

```ts
  inputOpen: false,
  feed: [],
  controlledTerminalIds: [],
```

Add the action signatures to the `CateAgentStore` interface (after `reset` on line 53):

```ts
  setInputOpen: (wsId: string, open: boolean) => void
  appendFeed: (wsId: string, kind: CateAgentFeedKind, text: string) => void
  clearFeed: (wsId: string) => void
  addControlledTerminal: (wsId: string, panelId: string) => void
  removeControlledTerminal: (wsId: string, panelId: string) => void
  clearControlledTerminals: (wsId: string) => void
```

Add the action implementations inside the store object (after `popRemark`, before `reset`):

```ts
  setInputOpen(wsId, open) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, inputOpen: open } } }
    })
  },

  appendFeed(wsId, kind, text) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      const item: CateAgentFeedItem = { id: ++feedSeq, kind, text, ts: Date.now() }
      return { byWs: { ...s.byWs, [wsId]: { ...prev, feed: [...prev.feed, item].slice(-MAX_FEED) } } }
    })
  },

  clearFeed(wsId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, feed: [] } } }
    })
  },

  addControlledTerminal(wsId, panelId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      if (prev.controlledTerminalIds.includes(panelId)) return s
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminalIds: [...prev.controlledTerminalIds, panelId] } } }
    })
  },

  removeControlledTerminal(wsId, panelId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminalIds: prev.controlledTerminalIds.filter((p) => p !== panelId) } } }
    })
  },

  clearControlledTerminals(wsId) {
    set((s) => {
      const prev = s.byWs[wsId] ?? DEFAULT_CATE_AGENT_WS
      return { byWs: { ...s.byWs, [wsId]: { ...prev, controlledTerminalIds: [] } } }
    })
  },
```

At the end of the file (after the `useCateAgentWs` hook), add a focused subscription hook for the glow:

```ts
/** Hook: true while the given terminal panel is being driven by the executor. */
export function useTerminalControlled(wsId: string | null | undefined, panelId: string): boolean {
  return useCateAgentStore((s) =>
    wsId ? (s.byWs[wsId]?.controlledTerminalIds ?? []).includes(panelId) : false,
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/cateAgent/cateAgentStore.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/cateAgent/cateAgentStore.ts src/renderer/cateAgent/cateAgentStore.test.ts
git commit -m "feat(cate-agent): add input/feed/controlled-terminal state to store"
```

---

## Task 2: Glow keyframes in global CSS

**Files:**
- Modify: `src/renderer/styles/globals.css`

- [ ] **Step 1: Add the keyframes + class**

`globals.css` already defines `--agent-rgb` at lines 61-62. Append this block near the other agent tokens / keyframes (end of the `:root` rules or end of file is fine — keyframes are global):

```css
/* Slow, clearly-visible accent pulse on a terminal the Cate Agent is driving. */
@keyframes cate-agent-terminal-glow {
  0%, 100% {
    box-shadow: 0 0 4px 1px rgb(var(--agent-rgb) / 0.45),
                inset 0 0 6px 0 rgb(var(--agent-rgb) / 0.25);
    border-color: rgb(var(--agent-rgb) / 0.55);
  }
  50% {
    box-shadow: 0 0 16px 4px rgb(var(--agent-rgb) / 0.85),
                inset 0 0 12px 0 rgb(var(--agent-rgb) / 0.45);
    border-color: rgb(var(--agent-rgb) / 0.95);
  }
}
.cate-agent-terminal-glow {
  border: 1.5px solid rgb(var(--agent-rgb) / 0.55);
  border-radius: 6px;
  animation: cate-agent-terminal-glow 2.4s ease-in-out infinite;
  pointer-events: none;
}
```

- [ ] **Step 2: Verify the build still compiles the CSS**

Run: `npx vitest run src/renderer/cateAgent/cateAgentStore.test.ts`
Expected: PASS (sanity — CSS isn't type-checked; this confirms nothing broke). Visual confirmation happens at manual run.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/styles/globals.css
git commit -m "feat(cate-agent): add terminal control glow keyframes"
```

---

## Task 3: Render the control glow in TerminalPanel

**Files:**
- Modify: `src/renderer/panels/TerminalPanel.tsx`

- [ ] **Step 1: Import the hook**

In `src/renderer/panels/TerminalPanel.tsx`, add to the imports (after the `cateAgentStore`-adjacent renderer imports — e.g. after line 23 `resolveTerminalFontSize`):

```ts
import { useTerminalControlled } from '../cateAgent/cateAgentStore'
```

- [ ] **Step 2: Subscribe inside the component**

Just after the component's existing hooks at the top of `TerminalPanel` (e.g. after the `resizeObserverRef` ref on line 60), add:

```ts
  const controlled = useTerminalControlled(workspaceId, panelId)
```

- [ ] **Step 3: Render the overlay ring**

In the returned JSX, the outer wrapper is `<div className="w-full h-full flex flex-col" ...>` at line 678. Add the glow overlay as the FIRST child of that wrapper (so it sits above the terminal content; `pointer-events: none` via the class keeps it click-through):

```tsx
      {controlled && (
        <div className="cate-agent-terminal-glow absolute inset-0 z-20" aria-hidden />
      )}
```

The outer wrapper is not positioned; change its className to include `relative` so the absolute overlay anchors to it. Replace:

```tsx
    <div className="w-full h-full flex flex-col" style={{ padding: 0 }}>
```

with:

```tsx
    <div className="relative w-full h-full flex flex-col" style={{ padding: 0 }}>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors in `TerminalPanel.tsx`. (If the repo has no root `tsconfig.json` with `noEmit`, run `npm run build` instead and confirm it compiles.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/panels/TerminalPanel.tsx
git commit -m "feat(cate-agent): glow terminals the executor is driving"
```

---

## Task 4: Tools — feed remarks, mark/unmark controlled terminals

**Files:**
- Modify: `src/renderer/cateAgent/cateAgentTools.ts`
- Test: `src/renderer/cateAgent/cateAgentStore.test.ts` (extend)

We test the observable effect (a remark lands in the feed) through the store, since `setRemark` writes to the store. The terminal mark/unmark calls are thin store calls verified by Task 1's store tests + typecheck here.

- [ ] **Step 1: Write the failing test (feed receives remarks)**

Append to `src/renderer/cateAgent/cateAgentStore.test.ts`:

```ts
describe('cateAgentStore — appendFeed kinds', () => {
  beforeEach(() => useCateAgentStore.setState({ byWs: {} }))

  it('records distinct kinds in order', () => {
    const s = useCateAgentStore.getState()
    s.appendFeed('w', 'user', 'do the thing')
    s.appendFeed('w', 'agent', 'on it')
    s.appendFeed('w', 'error', 'boom')
    expect(useCateAgentStore.getState().get('w').feed.map((f) => f.kind)).toEqual(['user', 'agent', 'error'])
  })
})
```

- [ ] **Step 2: Run to verify it passes already**

Run: `npx vitest run src/renderer/cateAgent/cateAgentStore.test.ts`
Expected: PASS — this asserts the Task 1 contract the tools rely on. (No red step here; it's a guard for the wiring below.)

- [ ] **Step 3: Make `setRemark` also append to the feed**

In `src/renderer/cateAgent/cateAgentTools.ts`, replace the `setRemark` body (lines 115-123) so it pushes a feed item alongside the ephemeral bubble:

```ts
function setRemark(wsId: string, text: string): void {
  const id = ++remarkSeq
  const cur = useCateAgentStore.getState().get(wsId).remarks
  useCateAgentStore.getState().patch(wsId, { remarks: [...cur, { id, text }].slice(-MAX_REMARKS) })
  // Mirror into the persistent feedback log so the panel above the toolbar keeps a
  // running record even after the bubble fades.
  useCateAgentStore.getState().appendFeed(wsId, 'agent', text)
  setTimeout(() => {
    const remarks = useCateAgentStore.getState().get(wsId).remarks.filter((r) => r.id !== id)
    useCateAgentStore.getState().patch(wsId, { remarks })
  }, REMARK_TTL_MS)
}
```

- [ ] **Step 4: Mark the terminal controlled on executor `create_terminal`**

In the `create_terminal` case, right after the terminal is created and tracked on the todo (after line 413 `todos.patchTodo(rootPath, todoId, { terminalNodeIds: [...existing, panelId] })`), add:

```ts
      // The executor is now driving this terminal — light it up until the run ends.
      if (ctx.role === 'executor') useCateAgentStore.getState().addControlledTerminal(wsId, panelId)
```

- [ ] **Step 5: Unmark on `close_terminal`**

In the `close_terminal` case, after the `closePanel` try/catch (after line 454, before `if (ptyId) clearExit(ptyId)`), add:

```ts
      useCateAgentStore.getState().removeControlledTerminal(wsId, terminalId)
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/renderer/cateAgent/cateAgentStore.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json` (or `npm run build`)
Expected: no new errors in `cateAgentTools.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/cateAgent/cateAgentTools.ts src/renderer/cateAgent/cateAgentStore.test.ts
git commit -m "feat(cate-agent): feed remarks and mark controlled terminals from tools"
```

---

## Task 5: Controller — clear glow on finalize, feed lifecycle, user prompt path

**Files:**
- Modify: `src/renderer/cateAgent/cateAgentController.ts`

The user prompt reuses the always-on observer session (it can `remark` + `propose_todo`, which is exactly the "respond and propose work I approve" flow). No new session type.

- [ ] **Step 1: Clear controlled terminals when an executor finalizes**

In `finalizeExecutor` (lines 356-372), after the `useCateAgentStore.getState().patch(...)` call that resets activity (line 365-369), add:

```ts
    useCateAgentStore.getState().clearControlledTerminals(ctx.workspaceId)
```

- [ ] **Step 2: Append a feed line when an executor starts**

In `startExecutor`, right after the `useCateAgentStore.getState().patch(wsId, { activity: 'working', ... })` call (line 340), add:

```ts
    useCateAgentStore.getState().appendFeed(wsId, 'status', `Working on "${todo.title}"`)
```

- [ ] **Step 3: Append a feed line on executor error**

In `onError` (lines 532-541), inside the `if (ctx.role === 'executor' && ctx.todoId)` branch, before `this.finalizeExecutor(ctx)` (line 536), add:

```ts
      useCateAgentStore.getState().appendFeed(ctx.workspaceId, 'error', message.slice(0, 200))
```

- [ ] **Step 4: Add the `prompt` method**

Add a new public method to the `CateAgentController` class, placed right after `observeNow` (after line 259):

```ts
  /** Handle a free-form user prompt typed into the toolbar input bar. Summons the
   *  Cate Agent if needed, echoes the user's message into the feed, then prompts
   *  the always-on observer session with the request + current workspace context.
   *  The observer can `remark` (→ feed) and `propose_todo` (→ suggested todos the
   *  user approves in the feedback panel). */
  async prompt(wsId: string, rootPath: string, text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    this.start()
    useCateAgentStore.getState().appendFeed(wsId, 'user', trimmed)
    const enabled = useCateAgentStore.getState().get(wsId).enabled
    if (!enabled) await this.summon(wsId, rootPath)
    const r = this.ws.get(wsId)
    if (!r?.observerPanelId) {
      useCateAgentStore.getState().appendFeed(wsId, 'error', 'Cate Agent could not start (check provider sign-in).')
      return
    }
    const context = await buildObserveContext(wsId, r.rootPath)
    const ask = `The user asked: "${trimmed}". Respond with a short remark, and propose_todo for any concrete work you would take on (the user approves todos before anything runs).`
    void promptCateAgent(r.observerPanelId, `${ask}\n\n${context}`)
  }
```

`buildObserveContext` and `promptCateAgent` are already imported (lines 25, 31-35). No new imports needed.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` (or `npm run build`)
Expected: no new errors in `cateAgentController.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/cateAgent/cateAgentController.ts
git commit -m "feat(cate-agent): clear glow on finalize, feed lifecycle, add user prompt path"
```

---

## Task 6: CateAgentFeedback panel

**Files:**
- Create: `src/renderer/cateAgent/CateAgentFeedback.tsx`

Renders the feed (status/agent/user/error lines) plus suggested-todo rows with Approve & run / Dismiss. Reuses the existing run/dismiss flow: `cateAgentController.runTodo` and `useTodosStore.removeTodo` (the same calls `TasksView` used for suggested todos).

- [ ] **Step 1: Create the component**

Create `src/renderer/cateAgent/CateAgentFeedback.tsx`:

```tsx
// =============================================================================
// CateAgentFeedback — the Cate Agent's output panel, docked above the toolbar.
//
// Shows the running feed (status/agent/user/error lines) and the Cate Agent's
// proposed todos inline, where the user approves (Approve & run) or dismisses
// them. Width is driven by its container (the toolbar stack), so it always
// matches the input bar. Hidden when there's nothing to show and input is closed.
// =============================================================================

import React from 'react'
import { Play, Sparkle, X } from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'
import { useTodosStore } from '../stores/todosStore'
import { useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import type { CateAgentFeedKind } from './cateAgentStore'

const KIND_CLASS: Record<CateAgentFeedKind, string> = {
  user: 'text-primary',
  agent: 'text-secondary',
  status: 'text-muted',
  error: 'text-red-400',
}

export const CateAgentFeedback: React.FC<{ rootPath: string }> = ({ rootPath }) => {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const cateAgent = useCateAgentWs(wsId)
  const todos = useTodosStore((s) => s.todosByRoot[rootPath])
  const removeTodo = useTodosStore((s) => s.removeTodo)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const suggested = (todos ?? []).filter((t) => t.status === 'suggested')
  const hasContent = cateAgent.feed.length > 0 || suggested.length > 0

  // Keep the newest feed line in view as items arrive.
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [cateAgent.feed.length, suggested.length])

  if (!wsId) return null
  if (!cateAgent.inputOpen && !hasContent) return null

  return (
    <div className="mb-2 w-full rounded-2xl border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)] overflow-hidden">
      <div ref={scrollRef} className="max-h-[40vh] overflow-y-auto px-3 py-2 flex flex-col gap-1.5">
        {!hasContent && (
          <div className="text-[12px] text-muted py-1">Ask the Cate Agent to do something…</div>
        )}

        {cateAgent.feed.map((item) => (
          <div key={item.id} className={`text-[12px] leading-snug break-words ${KIND_CLASS[item.kind]}`}>
            {item.kind === 'user' ? <span className="text-muted">You: </span> : null}
            {item.text}
          </div>
        ))}

        {suggested.map((t) => (
          <div key={t.id} className="rounded-lg border border-subtle bg-surface-1 px-2.5 py-2 flex flex-col gap-1.5">
            <div className="flex items-start gap-1.5">
              <Sparkle size={13} weight="fill" className="mt-[2px] flex-shrink-0 text-blue-400" />
              <span className="flex-1 min-w-0 text-[12.5px] leading-snug text-primary break-words">{t.title}</span>
            </div>
            {t.note && <div className="text-[11.5px] leading-snug text-muted break-words">{t.note}</div>}
            <div className="flex items-center gap-1.5 pt-0.5">
              <button
                onClick={() => wsId && void cateAgentController.runTodo(wsId, rootPath, t.id)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11.5px] text-white bg-blue-500 hover:bg-blue-600 transition-colors"
              >
                <Play size={10} weight="fill" /> Approve &amp; run
              </button>
              <button
                onClick={() => removeTodo(rootPath, t.id)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11.5px] text-muted hover:text-primary hover:bg-hover transition-colors"
              >
                <X size={10} /> Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` (or `npm run build`)
Expected: no errors. Confirms `runTodo`, `removeTodo`, `useCateAgentWs`, and `CateAgentFeedKind` are wired correctly.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/cateAgent/CateAgentFeedback.tsx
git commit -m "feat(cate-agent): add feedback panel with inline todo approval"
```

---

## Task 7: Toolbar — agent button, input bar, feedback mount

**Files:**
- Create: `src/renderer/cateAgent/CateAgentToolbarButton.tsx`
- Create: `src/renderer/cateAgent/CateAgentInputBar.tsx`
- Modify: `src/renderer/canvas/CanvasToolbar.tsx`

- [ ] **Step 1: Create the agent toolbar button**

Create `src/renderer/cateAgent/CateAgentToolbarButton.tsx`. It reuses the activity coloring from the old avatar and toggles input mode:

```tsx
// =============================================================================
// CateAgentToolbarButton — the Cate Agent's entry point, docked as the leftmost
// item of the canvas toolbar. Color reflects activity (off/resting gray,
// observing blue, working green); clicking it toggles the toolbar's prompt input.
// =============================================================================

import React from 'react'
import { CateLogo } from '../ui/CateLogo'
import { Tooltip } from '../ui/Tooltip'
import type { CateAgentActivity } from '../../shared/types'

const COLOR: Record<CateAgentActivity, string> = {
  off: 'var(--surface-5)',
  resting: 'var(--surface-5)',
  observing: '#60a5fa',
  working: '#4ade80',
}

export const CateAgentToolbarButton: React.FC<{
  activity: CateAgentActivity
  active: boolean
  onClick: () => void
}> = ({ activity, active, onClick }) => {
  const color = COLOR[activity] ?? COLOR.resting
  const busy = activity === 'working' || activity === 'observing'
  return (
    <Tooltip label="Cate Agent — ask it to do something" placement="top">
      <button
        type="button"
        onClick={onClick}
        aria-label="Cate Agent"
        aria-pressed={active}
        style={{
          WebkitTapHighlightColor: 'transparent',
          boxShadow: `0 0 0 2px color-mix(in srgb, ${color} ${busy ? 70 : 50}%, transparent)`,
        }}
        className={`w-9 h-9 flex items-center justify-center rounded-full transition-all duration-100 active:scale-[0.92] ${
          active ? 'bg-hover-strong' : 'bg-transparent hover:bg-hover-strong'
        }`}
      >
        <CateLogo size={20} />
      </button>
    </Tooltip>
  )
}
```

- [ ] **Step 2: Create the input bar**

Create `src/renderer/cateAgent/CateAgentInputBar.tsx`:

```tsx
// =============================================================================
// CateAgentInputBar — replaces the toolbar's tool buttons while the Cate Agent
// input is open. A single text field + send button that prompts the Cate Agent.
// Enter sends; Escape closes input mode.
// =============================================================================

import React from 'react'
import { PaperPlaneTilt } from '@phosphor-icons/react'

export const CateAgentInputBar: React.FC<{
  onSend: (text: string) => void
  onClose: () => void
}> = ({ onSend, onClose }) => {
  const [text, setText] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => { inputRef.current?.focus() }, [])

  const send = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <div className="flex items-center gap-1.5 pl-1 pr-1">
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); send() }
          else if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}
        placeholder="Ask the Cate Agent…"
        className="w-[320px] max-w-[60vw] bg-transparent text-[13px] text-primary px-2 py-1.5 outline-none placeholder:text-muted"
      />
      <button
        type="button"
        onClick={send}
        disabled={!text.trim()}
        aria-label="Send"
        className="w-8 h-8 flex items-center justify-center rounded-full text-secondary hover:text-primary hover:bg-hover-strong active:scale-[0.92] transition-all duration-100 disabled:opacity-30"
      >
        <PaperPlaneTilt size={16} weight="fill" />
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Wire them into CanvasToolbar**

In `src/renderer/canvas/CanvasToolbar.tsx`:

(a) Add imports near the top (after line 29 `import { Tooltip } ...`):

```ts
import { CateAgentToolbarButton } from '../cateAgent/CateAgentToolbarButton'
import { CateAgentInputBar } from '../cateAgent/CateAgentInputBar'
import { CateAgentFeedback } from '../cateAgent/CateAgentFeedback'
import { useCateAgentWs, useCateAgentStore } from '../cateAgent/cateAgentStore'
import { cateAgentController } from '../cateAgent/cateAgentController'
```

(b) Inside the `CanvasToolbar` component body, after `const zoomText = ...` (line 209), add:

```ts
  const cateAgent = useCateAgentWs(workspaceId)
  const inputOpen = cateAgent.inputOpen
  const toggleAgentInput = () => useCateAgentStore.getState().setInputOpen(workspaceId, !inputOpen)
  const closeAgentInput = () => useCateAgentStore.getState().setInputOpen(workspaceId, false)
  const sendAgentPrompt = (text: string) => void cateAgentController.prompt(workspaceId, rootPath, text)
```

(c) Replace the toolbar's pill content. The current structure (lines 268-333) is:

```tsx
      <div data-onboarding="toolbar" className="relative pointer-events-auto">
        <div className="rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
          <div className="flex items-center gap-0.5 px-1 py-1">
            {/* ...existing buttons... */}
          </div>
        </div>
      </div>
```

Wrap it so the feedback panel sits above, and the agent button is always leftmost with the rest swapped for the input bar in input mode. Replace the opening of that block (the `<div data-onboarding="toolbar" ...>` through its inner `<div className="flex items-center gap-0.5 px-1 py-1">`) so it reads:

```tsx
      <div data-onboarding="toolbar" className="relative pointer-events-auto flex flex-col items-stretch">
        <CateAgentFeedback rootPath={rootPath} />
        <div className="rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
          <div className="flex items-center gap-0.5 px-1 py-1">
            {/* Cate Agent — always leftmost; toggles the prompt input. */}
            <CateAgentToolbarButton
              activity={cateAgent.activity}
              active={inputOpen}
              onClick={toggleAgentInput}
            />
            <div className="w-px h-5 bg-surface-5 mx-1" />

            {inputOpen ? (
              <CateAgentInputBar onSend={sendAgentPrompt} onClose={closeAgentInput} />
            ) : (
              <>
```

Then, immediately AFTER the existing zoom-in `ToolbarButton` block that closes the default tools (the `<ToolbarButton onClick={onZoomIn} ...>` ending at line 330) and BEFORE the closing `</div>` of `flex items-center gap-0.5 px-1 py-1` (line 331), close the fragment:

```tsx
              </>
            )}
```

The net effect: in default mode the existing Select/Hand/worktree/panel/zoom buttons render inside the `<>...</>`; in input mode they're replaced by `<CateAgentInputBar/>`, while the agent button + divider stay put.

- [ ] **Step 4: Typecheck + run the existing toolbar test**

Run: `npx vitest run src/renderer/canvas/CanvasToolbar.test.ts`
Expected: PASS (the minimap-section tests are unaffected).
Run: `npx tsc --noEmit -p tsconfig.json` (or `npm run build`)
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/cateAgent/CateAgentToolbarButton.tsx src/renderer/cateAgent/CateAgentInputBar.tsx src/renderer/canvas/CanvasToolbar.tsx
git commit -m "feat(cate-agent): toolbar agent button, input bar, and feedback mount"
```

---

## Task 8: Remove the avatar and the sidebar Tasks view

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/sidebar/Sidebar.tsx`
- Modify: `src/renderer/stores/uiStore.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/canvas/CanvasToolbar.tsx`
- Delete: `src/renderer/cateAgent/CateAgentAvatar.tsx`
- Delete: `src/renderer/sidebar/TasksView.tsx`

- [ ] **Step 1: Stop rendering the avatar**

In `src/renderer/App.tsx`, remove the import on line 25:

```ts
import { CateAgentAvatar } from './cateAgent/CateAgentAvatar'
```

and remove the render on line 460:

```tsx
      <CateAgentAvatar />
```

- [ ] **Step 2: Remove the Tasks view from the sidebar**

In `src/renderer/sidebar/Sidebar.tsx`:
- Remove the import on line 6: `import { TasksView } from './TasksView'`
- Remove `ListChecks` from the `@phosphor-icons/react` import (line 19) if it's used nowhere else in the file (grep first; if used elsewhere, leave it).
- Remove the `tasks` entry from `VIEW_META` (line 34): `tasks: { icon: ListChecks, title: 'Tasks' },`
- Remove the `case 'tasks':` branch from `SidebarViewContent` (lines 75-76).

- [ ] **Step 3: Remove `'tasks'` from the view list + type**

In `src/renderer/stores/uiStore.ts` line 23, change:

```ts
const ALL_VIEWS: SidebarView[] = ['workspaces', 'explorer', 'git', 'search', 'tasks']
```

to:

```ts
const ALL_VIEWS: SidebarView[] = ['workspaces', 'explorer', 'git', 'search']
```

In `src/shared/types.ts` line 1169, change:

```ts
export type SidebarView = 'workspaces' | 'explorer' | 'git' | 'search' | 'tasks'
```

to:

```ts
export type SidebarView = 'workspaces' | 'explorer' | 'git' | 'search'
```

`normalizeSidebarLayout` (uiStore.ts) filters persisted layouts against `ALL_VIEWS`, so any saved `'tasks'` entry is dropped automatically — no migration code needed.

- [ ] **Step 4: Remove the dead avatar↔minimap corner swap**

In `src/renderer/canvas/CanvasToolbar.tsx`, the minimap drag still references `cateAgentCorner` (lines 243-246). With the avatar gone there's nothing to swap with; remove the swap so the minimap just docks where dragged. Replace:

```ts
      store.setUIState('minimapButtonCorner', next)
      // Landing on the Cate Agent's corner swaps the Cate Agent into the corner we just left.
      if (next === store.cateAgentCorner) {
        store.setUIState('cateAgentCorner', prev)
      }
```

with:

```ts
      store.setUIState('minimapButtonCorner', next)
```

The now-unused `prev` binding two lines above (`const prev = store.minimapButtonCorner`) — keep it only if still referenced; if TypeScript flags it as unused, delete that line too.

- [ ] **Step 5: Delete the dead files**

```bash
git rm src/renderer/cateAgent/CateAgentAvatar.tsx src/renderer/sidebar/TasksView.tsx
```

- [ ] **Step 6: Verify nothing else references the removed symbols**

Run:

```bash
grep -rn "CateAgentAvatar\|TasksView\|'tasks'\|\"tasks\"" src/renderer src/shared
```

Expected: no matches except possibly `cateAgentCorner` in `uiStateStore.ts` (that persisted field can stay harmlessly; it's no longer read by any renderer). If any live reference to `CateAgentAvatar`/`TasksView`/the `'tasks'` view remains, fix it.

- [ ] **Step 7: Typecheck + full test run**

Run: `npx tsc --noEmit -p tsconfig.json` (or `npm run build`)
Expected: no errors.
Run: `npm test`
Expected: PASS (env-only git-touching failures noted in CLAUDE.md are acceptable; nothing in the Cate Agent / sidebar / toolbar suites should regress).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(cate-agent): remove corner avatar and sidebar Tasks view"
```

---

## Task 9: Manual verification

**Files:** none (manual run)

- [ ] **Step 1: Launch the app**

Run: `npm run dev`

- [ ] **Step 2: Walk the redesign**

Confirm, in a project with a folder open:
1. No floating corner avatar; the Cate Agent button is the leftmost item on the bottom toolbar, colored by activity.
2. Clicking it replaces the tool buttons with a focused text input + send button; the agent button stays put. `Esc` or clicking the agent button again restores the tools.
3. Typing a request and pressing Enter (or send) shows your message in a panel above the toolbar (same width), then the agent's remark, and any proposed todos with Approve & run / Dismiss.
4. Approving a todo runs it; while the executor drives a terminal, that terminal node shows a slow accent-color glow that stops when the run ends.
5. The sidebar no longer has a Tasks tab.

- [ ] **Step 3: Note any gaps**

If the feedback panel doesn't surface full conversational replies (only remarks + status), that matches the v1 scope in the spec. Record any other deviation for follow-up.

---

## Self-Review Notes

- **Spec coverage:** Goal 1 (toolbar button) → Task 7; Goal 2 (input toggle) → Tasks 1, 7; Goal 3 (feedback panel + inline approval) → Tasks 1, 5, 6, 7; Goal 4 (sidebar todos removed) → Task 8; Goal 5 (terminal glow) → Tasks 1–5. Visibility rule (spec) → Task 6 (`inputOpen || hasContent`). User-prompt path (spec) → Task 5 (`prompt`). Error handling (no workspace) → Task 6 (`if (!wsId) return null`) + Task 5 (no observer → error feed line).
- **Type consistency:** `CateAgentFeedKind` = `'user' | 'agent' | 'status' | 'error'` is defined once (Task 1) and consumed in Tasks 4, 5, 6. `controlledTerminalIds`, `inputOpen`, `feed` names are identical across store, hook, tools, controller, and components. `useTerminalControlled`, `setInputOpen`, `appendFeed`, `addControlledTerminal`, `removeControlledTerminal`, `clearControlledTerminals` are spelled identically in their definition (Task 1) and every call site.
- **Decisions locked from the spec:** the user prompt reuses the observer session rather than a new executor session — this is the lowest-risk realization of "user approves todos in the feedback area" and avoids the executor's `todoId` requirement for `create_terminal`.
