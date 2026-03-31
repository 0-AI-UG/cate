// =============================================================================
// terminalRegistry — singleton registry for xterm.js Terminal instances
//
// Decouples terminal lifecycle from React component mount/unmount so that
// terminals survive workspace switches. Terminals are keyed by panelId and
// live until explicitly disposed via dispose().
// =============================================================================

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { useStatusStore } from '../stores/statusStore'
import { terminalRestoreData, replayTerminalLog } from './session'

// ---------------------------------------------------------------------------
// Theme — matches CanvasIDE dark palette (kept in sync with TerminalPanel.tsx)
// ---------------------------------------------------------------------------

const TERMINAL_THEME = {
  background: '#1E1E24',
  foreground: '#D4D4D4',
  cursor: '#AEAFAD',
  selectionBackground: '#264F78',
  selectionForeground: '#D4D4D4',
  black: '#1E1E24',
  red: '#F44747',
  green: '#4EC9B0',
  yellow: '#D7BA7D',
  blue: '#569CD6',
  magenta: '#C586C0',
  cyan: '#9CDCFE',
  white: '#D4D4D4',
  brightBlack: '#808080',
  brightRed: '#F44747',
  brightGreen: '#4EC9B0',
  brightYellow: '#D7BA7D',
  brightBlue: '#569CD6',
  brightMagenta: '#C586C0',
  brightCyan: '#9CDCFE',
  brightWhite: '#FFFFFF',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  terminal: Terminal
  fitAddon: FitAddon
  webglAddon: WebglAddon | null
  searchAddon: SearchAddon
  ptyId: string
  /** Cleanup functions for IPC listeners and xterm disposables. */
  cleanupListeners: Array<() => void>
}

interface CreateOpts {
  workspaceId: string
  cwd?: string
  initialInput?: string
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const registry = new Map<string, RegistryEntry>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns an existing RegistryEntry for panelId, or creates a new one.
 *
 * Terminal creation is async (PTY spawned via IPC). The returned entry is
 * immediately usable for attachment, but PTY wiring completes asynchronously.
 */
async function getOrCreate(panelId: string, opts: CreateOpts): Promise<RegistryEntry> {
  const existing = registry.get(panelId)
  if (existing) return existing

  const { electronAPI } = window
  const cleanupListeners: Array<() => void> = []

  // 1. Create xterm.js Terminal
  const terminal = new Terminal({
    theme: TERMINAL_THEME,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
  })

  // 2. FitAddon — load before opening so fit() is available immediately
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  // 2b. SearchAddon — enables find-in-terminal-scrollback
  const searchAddon = new SearchAddon()
  terminal.loadAddon(searchAddon)

  // 3. Open into a temporary off-screen div so xterm creates its DOM element.
  //    attach() will move that element into the real container later.
  const tempDiv = document.createElement('div')
  tempDiv.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:800px;height:600px;visibility:hidden'
  document.body.appendChild(tempDiv)
  terminal.open(tempDiv)

  // Remove the temp div from the DOM — xterm's element is now detached and
  // will be reparented by attach(). Leaving it leaks a DOM node per terminal.
  const xtermEl = (terminal as unknown as { element?: HTMLElement }).element
  if (xtermEl && tempDiv.contains(xtermEl)) {
    tempDiv.removeChild(xtermEl)
  }
  document.body.removeChild(tempDiv)

  // 4. Try WebGL renderer, fall back to canvas silently
  let webglAddon: WebglAddon | null = null
  try {
    webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => {
      webglAddon!.dispose()
      // Update entry in registry so getEntry reflects null
      const entry = registry.get(panelId)
      if (entry) entry.webglAddon = null
    })
    terminal.loadAddon(webglAddon)
  } catch {
    // Canvas renderer fallback — no action needed
    webglAddon = null
  }

  // Skip fitting against the temp div — its arbitrary 800×600 size produces
  // wrong cols/rows that desync the PTY until the real container attach().
  // Use standard 80×24 defaults; attach() will fit to the real container.

  // Build the entry with a placeholder ptyId; we'll fill it in once the PTY
  // is ready. Any code that reads ptyId should await getOrCreate() to finish.
  const entry: RegistryEntry = {
    terminal,
    fitAddon,
    webglAddon,
    searchAddon,
    ptyId: '', // filled below
    cleanupListeners,
  }

  // Register entry immediately so concurrent calls return the same object
  registry.set(panelId, entry)

  // 5. Spawn PTY via IPC (async — wires up listeners once ptyId is known)
  try {
    // Use standard defaults — the real fit happens in attach() once the
    // terminal is placed in its actual container.
    const cols = 80
    const rows = 24

    // Resolve cwd: prefer explicit opt, then fall back to restore data
    const resolvedCwd = opts.cwd ?? terminalRestoreData.get(panelId)?.cwd

    const shell = await electronAPI.settingsGet('defaultShellPath')
    const ptyId = await electronAPI.terminalCreate({
      cols,
      rows,
      cwd: resolvedCwd,
      shell: (shell as string) || undefined,
    })

    // If the entry was disposed while we were waiting, bail out
    if (!registry.has(panelId)) {
      terminal.dispose()
      return entry
    }

    entry.ptyId = ptyId

    // 6. PTY -> xterm: incoming data
    const removeDataListener = electronAPI.onTerminalData((id: string, data: string) => {
      if (id === ptyId) {
        terminal.write(data)
      }
    })
    cleanupListeners.push(removeDataListener)

    // 7. PTY exit notification
    const removeExitListener = electronAPI.onTerminalExit((id: string, exitCode: number) => {
      if (id === ptyId) {
        terminal.write(
          `\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`,
        )
      }
    })
    cleanupListeners.push(removeExitListener)

    // 8. xterm -> PTY: keystrokes
    const dataDisposable = terminal.onData((data) => {
      electronAPI.terminalWrite(ptyId, data)
    })
    cleanupListeners.push(() => dataDisposable.dispose())

    // 9. xterm resize -> PTY resize
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      electronAPI.terminalResize(ptyId, cols, rows)
    })
    cleanupListeners.push(() => resizeDisposable.dispose())

    // 10. Register with shell/process monitor (best-effort)
    electronAPI.shellRegisterTerminal(ptyId).catch(() => {})
    useStatusStore.getState().registerTerminal(ptyId, opts.workspaceId)

    // 11. Write initialInput after a short delay so the shell prompt is ready
    if (opts.initialInput) {
      setTimeout(() => {
        terminal.write(opts.initialInput!)
      }, 100)
    }

    // 12. Replay scrollback log if this terminal was restored from a session
    if (terminalRestoreData.has(panelId)) {
      replayTerminalLog(panelId).catch(() => {})
    }
  } catch (err) {
    if (registry.has(panelId)) {
      terminal.write(`\r\n\x1b[31mFailed to create terminal: ${err}\x1b[0m\r\n`)
    }
  }

  return entry
}

/**
 * Moves the xterm DOM element into container and calls fitAddon.fit().
 *
 * If the terminal is currently attached to a different container it is
 * detached first. Safe to call multiple times with the same container.
 *
 * When reparenting, the WebGL addon is disposed and reloaded because its
 * internal canvas buffers can become stale after a DOM move, causing garbled
 * rendering (characters drawn at wrong positions).
 */
function attach(panelId: string, container: HTMLDivElement): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const { terminal, fitAddon } = entry

  // xterm's internal viewport/screen elements live inside terminal.element
  const el = (terminal as unknown as { element?: HTMLElement }).element
  if (!el) return

  // Already attached to this exact container — just re-fit
  if (el.parentElement === container) {
    try { fitAddon.fit() } catch { /* ignore */ }
    return
  }

  // Detach from any previous container without disposing
  if (el.parentElement) {
    el.parentElement.removeChild(el)
  }

  container.appendChild(el)

  // Force layout reflow so the browser has calculated the new container size
  // before we resize the terminal / WebGL canvas.
  void container.offsetHeight

  // Reload the WebGL addon — its internal canvas buffers are tied to the old
  // container dimensions and cannot survive a DOM reparent reliably.
  if (entry.webglAddon) {
    try { entry.webglAddon.dispose() } catch { /* ignore */ }
    entry.webglAddon = null
  }
  try {
    const newWebgl = new WebglAddon()
    newWebgl.onContextLoss(() => {
      newWebgl.dispose()
      const e = registry.get(panelId)
      if (e) e.webglAddon = null
    })
    terminal.loadAddon(newWebgl)
    entry.webglAddon = newWebgl
  } catch {
    // Canvas renderer fallback — no action needed
  }

  // Fit after the next frame — the container may still be mid-layout during
  // the sync DOM append (e.g. WebGL canvas initialization).
  requestAnimationFrame(() => {
    if (!registry.has(panelId)) return
    try {
      fitAddon.fit()
      terminal.refresh(0, terminal.rows - 1)
    } catch { /* ignore */ }
  })
}

/**
 * Removes the xterm DOM element from its current container.
 * Does NOT dispose the terminal or kill the PTY — the terminal remains live
 * in the registry and can be re-attached via attach().
 */
function detach(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const el = (entry.terminal as unknown as { element?: HTMLElement }).element
  if (el?.parentElement) {
    el.parentElement.removeChild(el)
  }
}

/**
 * Fully tears down a terminal: kills the PTY, disposes all xterm addons and
 * the Terminal instance, removes IPC listeners, and removes the entry from
 * the registry.
 */
function dispose(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  // Remove from registry first so re-entrant calls are no-ops
  registry.delete(panelId)

  const { terminal, fitAddon, webglAddon, ptyId, cleanupListeners } = entry
  const { electronAPI } = window

  // Kill PTY and unregister from shell monitor
  if (ptyId) {
    electronAPI.terminalKill(ptyId).catch(() => {})
    electronAPI.shellUnregisterTerminal(ptyId).catch(() => {})
    useStatusStore.getState().unregisterTerminal(ptyId)
  }

  // Remove all IPC listeners and xterm disposables
  for (const cleanup of cleanupListeners) {
    cleanup()
  }
  cleanupListeners.length = 0

  // Detach DOM element before disposing
  const el = (terminal as unknown as { element?: HTMLElement }).element
  if (el?.parentElement) {
    el.parentElement.removeChild(el)
  }

  // Dispose addons then terminal
  if (webglAddon) {
    try { webglAddon.dispose() } catch { /* ignore */ }
    entry.webglAddon = null
  }

  // FitAddon does not have a dispose method on all versions; guard it
  if (typeof (fitAddon as unknown as { dispose?: () => void }).dispose === 'function') {
    try { (fitAddon as unknown as { dispose: () => void }).dispose() } catch { /* ignore */ }
  }

  try { terminal.dispose() } catch { /* ignore */ }
}

/** Returns the RegistryEntry for panelId, or undefined if not present. */
function getEntry(panelId: string): RegistryEntry | undefined {
  return registry.get(panelId)
}

/** Returns true if an entry exists for panelId. */
function has(panelId: string): boolean {
  return registry.has(panelId)
}

// ---------------------------------------------------------------------------
// Search API
// ---------------------------------------------------------------------------

function findNext(panelId: string, query: string): boolean {
  const entry = registry.get(panelId)
  if (!entry?.searchAddon) return false
  return entry.searchAddon.findNext(query)
}

function findPrevious(panelId: string, query: string): boolean {
  const entry = registry.get(panelId)
  if (!entry?.searchAddon) return false
  return entry.searchAddon.findPrevious(query)
}

function clearSearch(panelId: string): void {
  const entry = registry.get(panelId)
  entry?.searchAddon?.clearDecorations()
}

// ---------------------------------------------------------------------------
// Exported singleton
// ---------------------------------------------------------------------------

export const terminalRegistry = {
  getOrCreate,
  attach,
  detach,
  dispose,
  getEntry,
  has,
  findNext,
  findPrevious,
  clearSearch,
} as const
