// =============================================================================
// terminalDriver — renderer executor for the `cate.terminal.*` reverse API.
//
// The main process forwards a caller's `cate.terminal.*` call to the window that
// owns the target terminal panel; useCateHostActionResponder hands it here. We
// resolve WHICH terminal panel the call targets, then read its xterm buffer or
// write to its PTY through the terminalRegistry — the registry entry already
// carries the live Terminal (for reads) and its ptyId (for writes), decoupled
// from panel mount, so no extra per-panel registration is needed.
//
// Target resolution (see resolveTargetPanelId):
//   - explicit args.panelId — must be a terminal panel in THIS window's store
//   - `read` only: the focused panel, when it is a terminal. There is NO
//     first-terminal fallback (too ambiguous), and `type`/`press` never resolve
//     implicitly — a misresolved read is noise, a misresolved keystroke
//     executes in the wrong shell.
//
// SECURITY NOTE: `type` writes to the PTY exactly like user keystrokes
// (window.electronAPI.terminalWrite — the same path terminal.onData uses) but
// never appends a newline, so text lands in the input line without executing.
// Input additionally requires the cliTerminalInputEnabled setting, enforced
// main-side before the call ever reaches this driver. Terminals the Cate Agent
// orchestrator is actively driving reject input with `agent-owned-terminal`.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { getActivePanelId } from '../activePanel'
import { getEntry } from './registryState'
import { useCateAgentStore } from '../../../cateAgent/renderer/cateAgentStore'
import type { Terminal } from '@xterm/xterm'

export type TerminalOutcome = { ok: true; result?: unknown } | { ok: false; error: string }

/** Resolve which terminal panel a call targets. `allowFocused` is true only for
 *  `read` — input verbs must address their target explicitly. */
function resolveTargetPanelId(
  workspaceId: string,
  args: Record<string, unknown>,
  allowFocused: boolean,
): { panelId: string } | { error: string } {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  const explicit = typeof args.panelId === 'string' ? args.panelId : undefined
  if (explicit) {
    const panel = ws?.panels?.[explicit]
    // Mirror browserDriver: a panel detached into another window is absent from
    // this store, so we can't drive it here. Reject rather than lie.
    if (!panel || panel.type !== 'terminal') return { error: 'terminal-not-found' }
    return { panelId: explicit }
  }
  if (!allowFocused) return { error: 'panel-required' }
  const active = getActivePanelId()
  if (active && ws?.panels?.[active]?.type === 'terminal') return { panelId: active }
  return { error: 'no-terminal-focused' }
}

// --- press key map -----------------------------------------------------------
// Friendly key names (lowercased) → the raw byte sequence a terminal expects.
// Beyond this closed list, generic ctrl-<letter> chords are COMPUTED (ctrl-c →
// \x03) rather than enumerated. The sequences go to whatever runs in the
// terminal: a foreground TUI receives the keys, not the shell.
const PRESS_KEYS: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  home: '\x1b[H',
  end: '\x1b[F',
}

/** The byte sequence for a friendly key name (case-insensitive), or null when
 *  unsupported. `ctrl-<letter>` (or `ctrl+<letter>`) maps to the control byte
 *  (letter's position in the alphabet: ctrl-a = \x01 ... ctrl-z = \x1a). */
export function sequenceForKey(raw: string): string | null {
  const key = raw.toLowerCase()
  const direct = PRESS_KEYS[key]
  if (direct !== undefined) return direct
  const ctrl = /^ctrl[-+]([a-z])$/.exec(key)
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96)
  return null
}

// --- read --------------------------------------------------------------------

/** The rendered screen: the alt screen when a TUI holds the alternate buffer,
 *  otherwise the whole normal buffer including scrollback (the CLI caps the
 *  printed tail). Trailing blank lines are dropped. */
function readScreen(terminal: Terminal): { alt: boolean; text: string } {
  const buf = terminal.buffer.active
  const alt = buf.type === 'alternate'
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { alt, text: lines.join('\n') }
}

// --- Entry point -------------------------------------------------------------

/** Execute one `cate.terminal.*` method. `method` keeps its full
 *  `cate.terminal.` prefix (as it arrives at the responder). Always resolves
 *  (never throws). */
export async function handleTerminalMethod(
  workspaceId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<TerminalOutcome> {
  const name = method.slice('cate.terminal.'.length)
  if (name !== 'read' && name !== 'type' && name !== 'press') {
    return { ok: false, error: 'unsupported' }
  }

  const target = resolveTargetPanelId(workspaceId, args, name === 'read')
  if ('error' in target) return { ok: false, error: target.error }
  const entry = getEntry(target.panelId)
  if (!entry) return { ok: false, error: 'terminal-not-ready' }

  if (name === 'read') {
    const screen = readScreen(entry.terminal)
    return { ok: true, result: { panelId: target.panelId, ...screen } }
  }

  // Input (`type`/`press`). A terminal the Cate Agent orchestrator is actively
  // driving is off limits — CLI keystrokes would interleave with the agent's.
  const controlled = useCateAgentStore.getState().byWs[workspaceId]?.controlledTerminals?.[target.panelId]
  if (controlled) return { ok: false, error: 'agent-owned-terminal' }
  if (!entry.ptyId || entry.alive === false) return { ok: false, error: 'terminal-not-ready' }

  let data: string
  if (name === 'type') {
    if (typeof args.text !== 'string' || args.text === '') return { ok: false, error: 'text-required' }
    data = args.text
  } else {
    const seq = typeof args.key === 'string' ? sequenceForKey(args.key) : null
    if (seq === null) return { ok: false, error: 'unsupported-key' }
    data = seq
  }

  try {
    // The exact write path user keystrokes take (terminalLifecycle's onData).
    await window.electronAPI.terminalWrite(entry.ptyId, data)
    return { ok: true }
  } catch {
    return { ok: false, error: 'terminal-not-ready' }
  }
}
