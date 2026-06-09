// =============================================================================
// terminalLifecycle — terminal creation, reconnect, disposal, and the shared
// xterm construction + listener wiring. Operates on the registryState maps;
// setPtyForPanel stays the single bimap writer (release/dispose delete from
// ptyToPanel directly, as before).
// =============================================================================

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import log from '../logger'
import { errorMessage } from '../errorMessage'
import {
  registry,
  ptyToPanel,
  pendingTransfers,
  failures,
  setPtyForPanel,
  notifyFailure,
  workspaceIdForPty,
  type RegistryEntry,
} from './registryState'
import {
  getScrollback,
  getScrollSensitivity,
  getContrastRatio,
  getOptionIsMeta,
  effectiveCursorBlink,
} from './terminalSettings'
import { createTerminalLinkHandler, makeTerminalKeyEventHandler } from './terminalInput'
import { createFileLinkProvider, resolveLinkRoot } from './terminalFileLinkProvider'
import { getActiveTheme } from '../themeManager'
import { useStatusStore } from '../../stores/statusStore'
import { awaitWorkspaceSync, useAppStore } from '../../stores/appStore'
import { terminalRestoreData } from './terminalRestoreData'
import { replayTerminalLog } from '../workspace/session'
import { extractAgentTitleSegment, shellTitleBasename } from '../agent/agentTitleParser'
import { titleIndicatesRunning, outputShowsBodySpinner } from '../agent/agentSpinner'
import { noteAgentTitle, noteAgentSpinnerByte } from '../agent/agentScreenDetector'

interface CreateOpts {
  workspaceId: string
  cwd?: string
  initialInput?: string
}

/** Drive the panel tab title from an OSC 0/1/2 title — plain shells only.
 *  Agent terminals keep the detected agent name (set by useProcessMonitor and
 *  numbered for duplicates by updatePanelTitleFromAgent); their raw OSC title
 *  (cwd / spinner-prefixed name / session label) is inconsistent across agents,
 *  so it's ignored here. Plain shells let the OSC title drive the tab name,
 *  where it usefully reflects the cwd (collapsed to the folder for Windows
 *  shells that write the full path). */
function applyOscTitleIfNoAgent(
  ptyId: string,
  workspaceId: string,
  panelId: string,
  title: string,
): void {
  const status = useStatusStore.getState()
  const wsId = workspaceIdForPty(ptyId) ?? workspaceId
  if (status.workspaces[wsId]?.agentName[ptyId]) return
  useAppStore.getState().updatePanelTitleFromAgent(workspaceId, panelId, shellTitleBasename(title))
}

// ---------------------------------------------------------------------------
// Shared terminal construction + listener wiring
//
// getOrCreate() (fresh spawn) and reconnectTerminal() (cross-window transfer)
// build a byte-identical xterm Terminal + addon stack and register the same six
// listeners. These helpers are the single source of that, so the two paths
// can't drift. Path-specific differences (ptyId timing, entry shape, scrollback
// replay vs deferred finalizeReconnect) stay in each caller.
// ---------------------------------------------------------------------------

/** What a freshly-built terminal exposes to its caller. The file-link
 *  disposable has already been pushed onto `cleanupListeners`. */
interface ConfiguredTerminal {
  terminal: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  webglAddon: WebglAddon | null
  cleanupListeners: Array<() => void>
}

/**
 * Create an xterm Terminal with the canonical config, load the Fit/Search/
 * WebLinks addons + the file-path link provider, and return the live handles.
 *
 * terminal.open() is intentionally NOT called here — attach() opens the
 * terminal directly into its real container the first time it runs. Opening
 * into a temp div and reparenting worked on Electron 33 but breaks on Electron
 * 41 (the WebGL2 context created against the detached canvas never paints,
 * leaving an all-white terminal). terminal.write() before open() is fine: xterm
 * buffers writes until the renderer is initialized. So webglAddon starts null.
 */
export function createAndConfigureXtermTerminal(opts: CreateOpts): ConfiguredTerminal {
  const cleanupListeners: Array<() => void> = []

  const terminal = new Terminal({
    theme: getActiveTheme().terminal,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: effectiveCursorBlink(),
    allowProposedApi: true,
    scrollback: getScrollback(),
    scrollSensitivity: getScrollSensitivity(),
    macOptionIsMeta: getOptionIsMeta(),
    altClickMovesCursor: true,
    minimumContrastRatio: getContrastRatio(),
  })

  // FitAddon — load before opening so fit() is available immediately
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  // SearchAddon — enables find-in-terminal-scrollback
  const searchAddon = new SearchAddon()
  terminal.loadAddon(searchAddon)

  // WebLinksAddon — underline URLs on hover; Cmd/Ctrl+Click opens them
  // (see createTerminalLinkHandler). Disposed with the terminal.
  terminal.loadAddon(new WebLinksAddon(createTerminalLinkHandler(opts.workspaceId)))

  // File-path links — Cmd/Ctrl+Click opens the file in an editor at the parsed
  // line. (http/https URLs are handled by WebLinksAddon above.)
  const fileLinkDisposable = terminal.registerLinkProvider(
    createFileLinkProvider({
      terminal,
      workspaceId: opts.workspaceId,
      rootPath: resolveLinkRoot(opts.workspaceId, opts.cwd),
    }),
  )
  cleanupListeners.push(() => fileLinkDisposable.dispose())

  const webglAddon: WebglAddon | null = null

  return { terminal, fitAddon, searchAddon, webglAddon, cleanupListeners }
}

/**
 * Register the six PTY<->xterm listeners (incoming data, exit, OSC title,
 * custom key handler, outgoing data, resize) plus the shell/process-monitor
 * registration. Each disposable is pushed onto `cleanupListeners`. Must be
 * called only after ptyId is known and setPtyForPanel() has run, matching the
 * ordering both callers rely on.
 */
export function wireTerminalListeners(args: {
  panelId: string
  ptyId: string
  opts: CreateOpts
  terminal: Terminal
  cleanupListeners: Array<() => void>
}): void {
  const { panelId, ptyId, opts, terminal, cleanupListeners } = args
  const { electronAPI } = window

  // PTY -> xterm: incoming data
  const removeDataListener = electronAPI.onTerminalData((id: string, data: string) => {
    if (id === ptyId) {
      terminal.write(data)
      if (outputShowsBodySpinner(data)) noteAgentSpinnerByte(ptyId)
    }
  })
  cleanupListeners.push(removeDataListener)

  // PTY exit notification — mark the entry dead so registry membership no
  // longer implies a live PTY (the entry lingers so its buffer stays readable
  // and the exit line is visible until the panel is disposed).
  const removeExitListener = electronAPI.onTerminalExit((id: string, exitCode: number) => {
    if (id === ptyId) {
      const e = registry.get(panelId)
      if (e) e.alive = false
      terminal.write(
        `\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`,
      )
    }
  })
  cleanupListeners.push(removeExitListener)

  // OSC 0/1/2 — agent CLIs write their live status into the terminal title.
  // Forward the parsed middle segment to the panel title unless the user has
  // manually renamed the tab.
  const titleDisposable = terminal.onTitleChange((raw) => {
    const parsed = extractAgentTitleSegment(raw)
    if (!parsed) return
    const running = titleIndicatesRunning(parsed)
    // Defer to a microtask so OSC sequences arriving during xterm.write()
    // (e.g. scrollback replay on attach) don't run set() inside React's
    // commit phase, which would trip "Maximum update depth".
    queueMicrotask(() => {
      noteAgentTitle(ptyId, running)
      applyOscTitleIfNoAgent(ptyId, opts.workspaceId, panelId, parsed)
    })
  })
  cleanupListeners.push(() => titleDisposable.dispose())

  // Modified special keys + macOS line-editing chords — see
  // makeTerminalKeyEventHandler().
  terminal.attachCustomKeyEventHandler(makeTerminalKeyEventHandler(terminal, ptyId))

  // xterm -> PTY: keystrokes (standard path for all other input)
  const dataDisposable = terminal.onData((data) => {
    electronAPI.terminalWrite(ptyId, data)
  })
  cleanupListeners.push(() => dataDisposable.dispose())

  // xterm resize -> PTY resize
  const resizeDisposable = terminal.onResize(({ cols, rows }) => {
    electronAPI.terminalResize(ptyId, cols, rows)
  })
  cleanupListeners.push(() => resizeDisposable.dispose())

  // Register with shell/process monitor (best-effort)
  electronAPI.shellRegisterTerminal(ptyId).catch((err) => log.warn('[terminal] Shell register failed:', err))
  useStatusStore.getState().registerTerminal(ptyId, opts.workspaceId)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns an existing RegistryEntry for panelId, or creates a new one.
 *
 * Terminal creation is async (PTY spawned via IPC). The returned entry is
 * immediately usable for attachment, but PTY wiring completes asynchronously.
 */
export async function getOrCreate(panelId: string, opts: CreateOpts): Promise<RegistryEntry> {
  const existing = registry.get(panelId)
  if (existing) {
    if (existing.workspaceId !== opts.workspaceId) {
      // The same panel id is being mounted under a DIFFERENT workspace. A PTY
      // must never be shared across workspaces, so tear the stale one down and
      // build a fresh terminal for the requesting workspace below.
      dispose(panelId)
    } else {
      pendingTransfers.delete(panelId) // stale transfer would hijack a future fresh mount
      return existing
    }
  }
  // A retry starts here — clear any prior failure so observers re-render
  // back into the live terminal view.
  if (failures.delete(panelId)) notifyFailure(panelId)

  // Check for a pending cross-window transfer — reconnect to existing PTY
  const transfer = pendingTransfers.get(panelId)
  if (transfer) {
    pendingTransfers.delete(panelId)
    return reconnectTerminal(panelId, transfer.ptyId, transfer.scrollback, opts)
  }

  const { electronAPI } = window

  // 1-2. Create the xterm Terminal + addon stack (config/addons shared with
  //       reconnectTerminal via createAndConfigureXtermTerminal). The file-link
  //       disposable is already pushed onto cleanupListeners. terminal.open()
  //       is deferred to attach(); webglAddon starts null.
  const { terminal, fitAddon, searchAddon, webglAddon, cleanupListeners } =
    createAndConfigureXtermTerminal(opts)

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
    lastScrollTop: 0,
    hasScrollListener: false,
    hasVisibilityListener: false,
    workspaceId: opts.workspaceId,
    alive: true,
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

    // If cwd points at a workspace rootPath that was just picked, the main
    // process may not have registered it as an allowed root yet (workspace
    // create/update is async). Wait for any pending sync so validateCwd in
    // main sees the up-to-date allowedRoots set.
    if (resolvedCwd) {
      await awaitWorkspaceSync()
    }

    const shell = await electronAPI.settingsGet('defaultShellPath')
    const ptyId = await electronAPI.terminalCreate({
      cols,
      rows,
      cwd: resolvedCwd,
      shell: (shell as string) || undefined,
      workspaceId: opts.workspaceId,
    })

    // If the entry was disposed while we were waiting, bail out
    if (!registry.has(panelId)) {
      terminal.dispose()
      return entry
    }

    setPtyForPanel(panelId, ptyId)

    // 6. Wire PTY<->xterm listeners + shell registration (shared with
    //    reconnectTerminal via wireTerminalListeners).
    wireTerminalListeners({ panelId, ptyId, opts, terminal, cleanupListeners })

    // 11. Write initialInput immediately — the PTY buffers writes until the
    //     shell is ready to consume them, so a fixed setTimeout was both
    //     fragile (slow systems) and unnecessary.
    if (opts.initialInput) {
      terminal.write(opts.initialInput)
    }

    // 12. Replay scrollback log if this terminal was restored from a session
    if (terminalRestoreData.has(panelId)) {
      replayTerminalLog(panelId).catch((err) => log.warn('[terminal] Replay log failed:', err))
    }
  } catch (err) {
    // Tear down the half-built entry so retry() can rebuild from scratch
    // instead of leaving a permanent tombstone with the red error frozen in it.
    failures.set(panelId, errorMessage(err, 'Terminal failed to start'))
    if (registry.get(panelId) === entry) {
      registry.delete(panelId)
      try { terminal.dispose() } catch { /* ignore */ }
    }
    notifyFailure(panelId)
  }

  return entry
}

/**
 * Reconnect to an existing PTY in a new renderer process (cross-window transfer).
 * Creates a fresh xterm Terminal (objects can't cross process boundaries) and wires
 * it to the existing PTY ID.  Calls panelTransferAck AFTER listeners are registered
 * so no buffered data is lost.
 */
export async function reconnectTerminal(
  panelId: string,
  ptyId: string,
  scrollback: string | undefined,
  opts: CreateOpts,
): Promise<RegistryEntry> {
  // 1. Create a fresh xterm Terminal + addon stack (config/addons shared with
  //    getOrCreate via createAndConfigureXtermTerminal). The file-link
  //    disposable is already pushed onto cleanupListeners; terminal.open() is
  //    deferred to attach(); webglAddon starts null.
  const { terminal, fitAddon, searchAddon, webglAddon, cleanupListeners } =
    createAndConfigureXtermTerminal(opts)

  const entry: RegistryEntry = {
    terminal,
    fitAddon,
    webglAddon,
    searchAddon,
    ptyId,
    cleanupListeners,
    lastScrollTop: 0,
    hasScrollListener: false,
    hasVisibilityListener: false,
    workspaceId: opts.workspaceId,
    alive: true,
  }

  // Defer scrollback write + panelTransferAck until attach() opens the fresh
  // xterm into its real container. Until then, the xterm is at xterm's default
  // 80×24 dimensions; writing wider scrollback or letting main flush buffered
  // PTY output here would wrap content and desync TUI alt-screen state.
  entry.pendingReconnect = { ptyId, scrollback }

  registry.set(panelId, entry)
  setPtyForPanel(panelId, ptyId)

  // 3. Wire PTY<->xterm listeners + shell registration to the EXISTING PTY
  //    (shared with getOrCreate via wireTerminalListeners).
  wireTerminalListeners({ panelId, ptyId, opts, terminal, cleanupListeners })

  // panelTransferAck is deferred to attach() — finalizeReconnect() below.
  return entry
}

/**
 * Apply the deferred parts of a cross-window reconnect once attach() has
 * opened+fitted the xterm to its real container: write the captured
 * scrollback at the correct dimensions, then ACK the transfer so main flushes
 * buffered PTY output into a now-correctly-sized buffer.
 */
export function finalizeReconnect(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry?.pendingReconnect) return

  const { ptyId, scrollback } = entry.pendingReconnect
  entry.pendingReconnect = undefined

  const { electronAPI } = window

  if (scrollback) {
    // captureScrollback joins rows with bare '\n'. Writing that to xterm
    // line-feeds WITHOUT a carriage return, so each row starts at the previous
    // row's end column — the staircase that scattered detached `ls`/grid output.
    // Normalize to '\r\n' so every row returns to column 0, matching how the
    // session-restore path (replayTerminalLog) already replays its lines.
    entry.terminal.write(scrollback.replace(/\r?\n/g, '\r\n') + '\r\n')
  }
  electronAPI
    .panelTransferAck(ptyId)
    .catch((err) => log.warn('[terminal] Transfer ack failed:', err))
}

/**
 * Deposit transfer data for a panel about to be received in this window.
 * Must be called BEFORE React renders the TerminalPanel so that getOrCreate()
 * finds the pending transfer and reconnects instead of spawning a new PTY.
 */
export function setPendingTransfer(panelId: string, ptyId: string, scrollback?: string): void {
  pendingTransfers.set(panelId, { ptyId, scrollback })
}

/**
 * Release a terminal from this window's registry without killing the PTY.
 * Used by the source window after a cross-window transfer — the PTY continues
 * to live in the main process, owned by the target window.
 */
export function release(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  registry.delete(panelId)
  if (entry.ptyId) ptyToPanel.delete(entry.ptyId)
  pendingTransfers.delete(panelId) // stale transfer would hijack a future fresh mount

  teardownEntry(entry)
}

/**
 * Shared teardown for a registry entry: removes IPC listeners and xterm
 * disposables, detaches the DOM element, and disposes addons + the Terminal.
 * Does NOT touch the registry maps or kill the PTY — callers own that.
 */
function teardownEntry(entry: RegistryEntry): void {
  const { terminal, fitAddon, webglAddon, cleanupListeners } = entry

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

/**
 * Fully tears down a terminal: kills the PTY, disposes all xterm addons and
 * the Terminal instance, removes IPC listeners, and removes the entry from
 * the registry.
 */
export function dispose(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  // Remove from registry first so re-entrant calls are no-ops
  registry.delete(panelId)
  if (entry.ptyId) ptyToPanel.delete(entry.ptyId)
  pendingTransfers.delete(panelId) // stale transfer would hijack a future fresh mount

  const { ptyId } = entry
  const { electronAPI } = window

  // Kill PTY and unregister from shell monitor
  if (ptyId) {
    electronAPI.terminalKill(ptyId).catch((err) => log.warn('[terminal] Kill failed:', err))
    electronAPI.shellUnregisterTerminal(ptyId).catch((err) => log.warn('[terminal] Shell unregister failed:', err))
    useStatusStore.getState().unregisterTerminal(ptyId)
  }

  teardownEntry(entry)
}

/**
 * Dispose every terminal owned by a workspace. Called when a workspace is
 * removed so its PTYs can't linger or be reused under another workspace.
 */
export function disposeWorkspace(workspaceId: string): void {
  const ids: string[] = []
  for (const [panelId, entry] of registry) {
    if (entry.workspaceId === workspaceId) ids.push(panelId)
  }
  for (const id of ids) dispose(id)
}
