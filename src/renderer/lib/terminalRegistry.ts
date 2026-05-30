// =============================================================================
// terminalRegistry — singleton registry for xterm.js Terminal instances
//
// Decouples terminal lifecycle from React component mount/unmount so that
// terminals survive workspace switches. Terminals are keyed by panelId and
// live until explicitly disposed via dispose().
// =============================================================================

import { Terminal } from '@xterm/xterm'
import log from './logger'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useStatusStore } from '../stores/statusStore'
import { useSettingsStore } from '../stores/settingsStore'
import { terminalRestoreData, replayTerminalLog } from './session'
import { awaitWorkspaceSync, useAppStore } from '../stores/appStore'
import { extractAgentTitleSegment } from './agentTitleParser'
import { titleIndicatesRunning, outputShowsBodySpinner } from './agentSpinner'
import { noteAgentTitle, noteAgentSpinnerByte } from './agentScreenDetector'
import { openTerminalUrl } from './terminalUrlOpen'
import { resolveTerminalKeySequence } from './terminalKeymap'
import { getActiveTheme, subscribeTheme } from './themeManager'
import type { Theme } from '../../shared/types'
import { createFileLinkProvider, resolveLinkRoot } from './terminalFileLinkProvider'
import { resolveTerminalLinkTarget } from './terminalLinks'

/** Agent terminals show the clean detected agent name (e.g. "Codex", "Claude
 *  Code") as their tab title — set by useProcessMonitor — not the agent's raw
 *  OSC title, which is inconsistent across agents (codex → cwd, claude →
 *  "✳ Claude Code", others → session labels) and flickers the spinner glyph.
 *  Only plain shells (no detected agent) let the OSC title drive the tab name,
 *  where it usefully reflects the cwd. */
function applyOscTitleIfNoAgent(
  ptyId: string,
  workspaceId: string,
  panelId: string,
  title: string,
): void {
  const status = useStatusStore.getState()
  const wsId = status.terminalWorkspaceMap[ptyId] ?? workspaceId
  if (status.workspaces[wsId]?.agentName[ptyId]) return
  useAppStore.getState().updatePanelTitleFromAgent(workspaceId, panelId, title)
}

/** Read the configured scrollback limit, clamped to a sane range. */
function getScrollback(): number {
  const raw = useSettingsStore.getState().terminalScrollback
  if (!Number.isFinite(raw) || raw <= 0) return 2000
  return Math.max(100, Math.min(raw, 10000))
}

/** Clamp a raw terminalScrollSpeed multiplier (xterm `scrollSensitivity`) to the
 *  slider range. Invalid / non-positive values fall back to the xterm default. */
export function clampScrollSensitivity(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1.0
  return Math.max(0.25, Math.min(raw, 3.0))
}

/** Read the configured terminal scroll-speed multiplier (xterm `scrollSensitivity`). */
function getScrollSensitivity(): number {
  return clampScrollSensitivity(useSettingsStore.getState().terminalScrollSpeed)
}

function getCursorBlink(): boolean {
  return useSettingsStore.getState().terminalCursorBlink === true
}

/** Read whether ⌥ Option acts as Meta in the terminal (xterm macOptionIsMeta).
 *  Defaults to true (preserve historical behavior) when unset. */
function getOptionIsMeta(): boolean {
  return useSettingsStore.getState().terminalOptionIsMeta !== false
}

// Track OS-window focus so we can pause cursor blinking while this window is
// not frontmost. A blinking cursor forces a GPU draw + WindowServer composite
// on every blink; xterm keeps blinking the focused terminal even when the app
// is backgrounded-but-visible, so we gate on the window 'blur'/'focus' events
// (not visibilitychange — a backgrounded window is still "visible" and painting).
let windowFocused = typeof document !== 'undefined' ? document.hasFocus() : true

/** Effective blink state = user setting AND this window is frontmost. */
function effectiveCursorBlink(): boolean {
  return getCursorBlink() && windowFocused
}

const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)

/**
 * True for the Windows/Linux paste chord (Ctrl+V or Ctrl+Shift+V). xterm.js has
 * no built-in Ctrl+V binding, so it would otherwise encode a literal ^V (0x16)
 * to the PTY. The caller returns false for this chord, which makes xterm skip
 * the key WITHOUT calling preventDefault — so the browser still fires its native
 * paste event into xterm's textarea and xterm performs the paste exactly once
 * (honouring bracketed-paste mode). macOS keeps Ctrl+V as the terminal "literal
 * next" key and pastes with Cmd+V instead.
 */
export function isTerminalPasteChord(event: KeyboardEvent, isMac = isMacPlatform): boolean {
  if (isMac) return false
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return false
  return event.key === 'v' || event.key === 'V'
}

export function isTerminalCopyChord(
  event: KeyboardEvent,
  terminal: { hasSelection(): boolean },
  isMac = isMacPlatform,
): boolean {
  if (isMac) return false
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return false
  if (event.key !== 'c' && event.key !== 'C') return false
  return terminal.hasSelection()
}

/**
 * Open a primary (non-Shift) clicked terminal link per the
 * `terminalLinkOpenTarget` setting: 'canvas' opens an in-app BrowserPanel,
 * 'external' opens the system browser, and 'ask' shows a native dialog the
 * first time — the choice is then remembered (written to the setting) and can
 * be changed later in Settings → Browser.
 */
async function openPrimaryTerminalLink(workspaceId: string, uri: string): Promise<void> {
  let target = useSettingsStore.getState().terminalLinkOpenTarget
  if (target === 'ask') {
    const choice = await window.electronAPI.promptTerminalLinkOpen(uri)
    if (choice === 'cancel') return
    useSettingsStore.getState().setSetting('terminalLinkOpenTarget', choice)
    target = choice
  }
  if (target === 'canvas') openTerminalUrl(workspaceId, uri)
  else window.electronAPI.openExternalUrl(uri)
}

/**
 * WebLinksAddon click handler shared by the fresh-spawn and reconnect paths.
 * Mirrors VS Code: Cmd/Ctrl+Click opens the URL (destination per the
 * `terminalLinkOpenTarget` setting), +Shift always opens it in the external
 * system browser, and a plain click is ignored.
 */
function createTerminalLinkHandler(
  workspaceId: string,
): (event: MouseEvent, uri: string) => void {
  return (event: MouseEvent, uri: string): void => {
    switch (resolveTerminalLinkTarget(event, isMacPlatform)) {
      case 'panel':
        void openPrimaryTerminalLink(workspaceId, uri)
        break
      case 'external':
        window.electronAPI.openExternalUrl(uri)
        break
      case 'ignore':
        break
    }
  }
}

// ---------------------------------------------------------------------------
// xterm custom key-event handler
//
// One factory shared by getOrCreate() and reconnectTerminal() (previously two
// copies). It covers, in order: paste/copy chords, macOS line-editing chords
// (Cmd/Option + Backspace/Delete/Arrows → literal control bytes), and CSI-u
// encoding for modified special keys (Ctrl+Enter, Shift+Tab, …) so shells and
// TUIs can tell them apart. Returning false makes xterm skip the key; we only
// preventDefault when we've written bytes ourselves.
// ---------------------------------------------------------------------------

/** Special keys xterm doesn't translate to distinct escape sequences — encoded
 *  as CSI u (fixterms/kitty) so shells/TUIs can distinguish the combos. */
const CSI_U_KEYS: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  Escape: 27,
  Space: 32,
}

function makeTerminalKeyEventHandler(
  terminal: { hasSelection(): boolean },
  ptyId: string,
): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent) => {
    if (event.type !== 'keydown') return true

    // Skip without preventDefault so the browser still fires the native paste
    // event into xterm's textarea (xterm then pastes exactly once).
    if (isTerminalPasteChord(event)) return false
    if (isTerminalCopyChord(event, terminal)) return false

    // macOS line-editing chords → literal bytes the shell's line editor reads,
    // matching VS Code / Cursor. Pure table lives in terminalKeymap.ts.
    const seq = resolveTerminalKeySequence(event, isMacPlatform)
    if (seq !== null) {
      window.electronAPI.terminalWrite(ptyId, seq)
      event.preventDefault()
      return false
    }

    const keyCode = CSI_U_KEYS[event.key]
    if (keyCode === undefined) return true // let xterm handle all other keys

    // Build modifier param: 1 + (shift=1, alt=2, ctrl=4, meta=8)
    let mod = 1
    if (event.shiftKey) mod += 1
    if (event.altKey) mod += 2
    if (event.ctrlKey) mod += 4
    if (event.metaKey) mod += 8

    if (mod === 1) return true // no modifier — let xterm handle normally
    if (event.key === 'Tab' && mod === 2) return true // Shift+Tab = reverse-tab
    // Remaining Cmd+key combos are app shortcuts — let them propagate.
    if (event.metaKey) return true

    window.electronAPI.terminalWrite(ptyId, `\x1b[${keyCode};${mod}u`)
    event.preventDefault()
    return false
  }
}

/** Apply the active theme's terminal palette to every live terminal. Called
 *  whenever the unified theme changes. */
function repaintAllTerminals(theme: Theme): void {
  for (const entry of registry.values()) {
    entry.terminal.options.theme = theme.terminal
  }
}

/** Apply a cursor-blink state to every live terminal. */
function applyCursorBlinkToAll(blink: boolean): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.cursorBlink = blink
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
}

/** Apply a scroll-speed multiplier (xterm `scrollSensitivity`) to every live terminal. */
function applyScrollSensitivityToAll(value: number): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.scrollSensitivity = value
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
}

/** Apply the ⌥ Option-as-Meta setting (xterm `macOptionIsMeta`) to every live terminal. */
function applyOptionIsMetaToAll(value: boolean): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.macOptionIsMeta = value
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
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
  /** Last known viewport scrollTop — continuously tracked for scroll restore on focus. */
  lastScrollTop: number
  /**
   * Saved buffer scroll position captured when the panel is hidden/detached, so
   * it can be restored after the xterm DOM element is re-parented (and the
   * browser zeroes its scrollTop) on the next attach(). Uses the buffer LINE
   * index (viewportY) rather than pixel scrollTop because scrollTop is reset by
   * the reparent and stale after fit() changes the row count. `atBottom` lets a
   * follow-output terminal snap to the freshest line instead of an old index.
   */
  savedViewport?: { line: number; atBottom: boolean }
  /** True once a scroll listener has been attached — prevents duplicates across re-attach cycles. */
  hasScrollListener: boolean
  /** Owning workspace — used to route auto-detected URLs to the right browser panel. */
  workspaceId: string
  /**
   * Set during reconnectTerminal when scrollback + panelTransferAck must be
   * deferred until attach() has opened the fresh xterm into its real
   * container. Without this, the scrollback would be written and PTY data
   * flushed into an unopened 80×24-default xterm, baking wrap artifacts and
   * desynced alt-screen state into the buffer before the real container
   * dimensions are known. Cleared once finalized.
   */
  pendingReconnect?: { ptyId: string; scrollback?: string }
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

// Transfer data deposited by shell code before TerminalPanel mounts in a new
// window.  getOrCreate() checks this map and enters reconnect mode if found.
const pendingTransfers = new Map<string, { ptyId: string; scrollback?: string }>()

// Per-panel last-known create failure, surfaced by TerminalPanel as a Retry
// overlay so a dead panel can recover without restarting the app.
const failures = new Map<string, string>()
const failureListeners = new Set<(panelId: string) => void>()
function notifyFailure(panelId: string): void {
  for (const fn of failureListeners) {
    try { fn(panelId) } catch { /* ignore listener errors */ }
  }
}

// ---------------------------------------------------------------------------
// Live theme swap — update all live terminals when the app theme changes
// ---------------------------------------------------------------------------

subscribeTheme((theme) => {
  repaintAllTerminals(theme)
})

// Live-apply terminal settings (cursor-blink toggle, scroll speed, Option-as-Meta)
// so changes are visible without a reload.
let lastCursorBlink = getCursorBlink()
let lastScrollSensitivity = getScrollSensitivity()
let lastOptionIsMeta = getOptionIsMeta()
useSettingsStore.subscribe((state) => {
  const cursorBlink = state.terminalCursorBlink === true
  if (cursorBlink !== lastCursorBlink) {
    lastCursorBlink = cursorBlink
    applyCursorBlinkToAll(cursorBlink && windowFocused)
  }
  const scrollSensitivity = clampScrollSensitivity(state.terminalScrollSpeed)
  if (scrollSensitivity !== lastScrollSensitivity) {
    lastScrollSensitivity = scrollSensitivity
    applyScrollSensitivityToAll(scrollSensitivity)
  }
  const optionIsMeta = state.terminalOptionIsMeta !== false
  if (optionIsMeta !== lastOptionIsMeta) {
    lastOptionIsMeta = optionIsMeta
    applyOptionIsMetaToAll(optionIsMeta)
  }
})

// Pause cursor blinking while this window is not frontmost, resume on return.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    windowFocused = true
    applyCursorBlinkToAll(getCursorBlink())
  })
  window.addEventListener('blur', () => {
    windowFocused = false
    applyCursorBlinkToAll(false)
  })
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
async function getOrCreate(panelId: string, opts: CreateOpts): Promise<RegistryEntry> {
  const existing = registry.get(panelId)
  if (existing) {
    pendingTransfers.delete(panelId) // stale transfer would hijack a future fresh mount
    return existing
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
  const cleanupListeners: Array<() => void> = []

  // 1. Create xterm.js Terminal
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
    minimumContrastRatio: 1,
  })

  // 2. FitAddon — load before opening so fit() is available immediately
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  // 2b. SearchAddon — enables find-in-terminal-scrollback
  const searchAddon = new SearchAddon()
  terminal.loadAddon(searchAddon)

  // 2c. WebLinksAddon — underline URLs on hover; Cmd/Ctrl+Click opens them
  //     (see createTerminalLinkHandler). Disposed with the terminal.
  terminal.loadAddon(new WebLinksAddon(createTerminalLinkHandler(opts.workspaceId)))

  // 2d. File-path links — Cmd/Ctrl+Click opens the file in an editor at the
  //     parsed line. (http/https URLs are handled by WebLinksAddon above.)
  const fileLinkDisposable = terminal.registerLinkProvider(
    createFileLinkProvider({
      terminal,
      workspaceId: opts.workspaceId,
      rootPath: resolveLinkRoot(opts.workspaceId, opts.cwd),
    }),
  )
  cleanupListeners.push(() => fileLinkDisposable.dispose())

  // 3. Do NOT call terminal.open() here. attach() opens the terminal directly
  //    into its real container the first time it runs. Opening into a temp div
  //    and then reparenting the xterm element worked on Electron 33 but breaks
  //    on Electron 41 — the WebGL2 context created against the detached canvas
  //    never paints, leaving an all-white terminal. terminal.write() before
  //    open() is fine: xterm buffers writes until the renderer is initialized.
  const webglAddon: WebglAddon | null = null

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
    workspaceId: opts.workspaceId,
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
        if (outputShowsBodySpinner(data)) noteAgentSpinnerByte(ptyId)
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

    // 7b. OSC 0/1/2 — agent CLIs write their live status into the terminal
    // title. Forward the parsed middle segment to the panel title unless the
    // user has manually renamed the tab.
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

    // 8. Modified special keys + macOS line-editing chords — see
    //    makeTerminalKeyEventHandler().
    terminal.attachCustomKeyEventHandler(makeTerminalKeyEventHandler(terminal, ptyId))

    // 8b. xterm -> PTY: keystrokes (standard path for all other input)
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
    electronAPI.shellRegisterTerminal(ptyId).catch((err) => log.warn('[terminal] Shell register failed:', err))
    useStatusStore.getState().registerTerminal(ptyId, opts.workspaceId)

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
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : String(err)
    failures.set(panelId, message)
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
async function reconnectTerminal(
  panelId: string,
  ptyId: string,
  scrollback: string | undefined,
  opts: CreateOpts,
): Promise<RegistryEntry> {
  const { electronAPI } = window
  const cleanupListeners: Array<() => void> = []

  // 1. Create a fresh xterm Terminal (same config as getOrCreate)
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
    minimumContrastRatio: 1,
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  const searchAddon = new SearchAddon()
  terminal.loadAddon(searchAddon)

  // WebLinksAddon — same as getOrCreate (shared click handler).
  terminal.loadAddon(new WebLinksAddon(createTerminalLinkHandler(opts.workspaceId)))

  // File-path links — same as getOrCreate.
  const fileLinkDisposable = terminal.registerLinkProvider(
    createFileLinkProvider({
      terminal,
      workspaceId: opts.workspaceId,
      rootPath: resolveLinkRoot(opts.workspaceId, opts.cwd),
    }),
  )
  cleanupListeners.push(() => fileLinkDisposable.dispose())

  // attach() will call terminal.open() directly into the real container —
  // see getOrCreate() for the rationale.
  const webglAddon: WebglAddon | null = null

  const entry: RegistryEntry = {
    terminal,
    fitAddon,
    webglAddon,
    searchAddon,
    ptyId,
    cleanupListeners,
    lastScrollTop: 0,
    hasScrollListener: false,
    workspaceId: opts.workspaceId,
  }

  // Defer scrollback write + panelTransferAck until attach() opens the fresh
  // xterm into its real container. Until then, the xterm is at xterm's default
  // 80×24 dimensions; writing wider scrollback or letting main flush buffered
  // PTY output here would wrap content and desync TUI alt-screen state.
  entry.pendingReconnect = { ptyId, scrollback }

  registry.set(panelId, entry)

  // 3. Wire up listeners to the EXISTING PTY
  const removeDataListener = electronAPI.onTerminalData((id: string, data: string) => {
    if (id === ptyId) {
      terminal.write(data)
      if (outputShowsBodySpinner(data)) noteAgentSpinnerByte(ptyId)
    }
  })
  cleanupListeners.push(removeDataListener)

  const removeExitListener = electronAPI.onTerminalExit((id: string, exitCode: number) => {
    if (id === ptyId) {
      terminal.write(
        `\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`,
      )
    }
  })
  cleanupListeners.push(removeExitListener)

  // OSC 0/1/2 — same forwarding as the fresh-spawn path; reconnects need the
  // listener too so titles keep tracking the agent after attach().
  const titleDisposable = terminal.onTitleChange((raw) => {
    const parsed = extractAgentTitleSegment(raw)
    if (!parsed) return
    const running = titleIndicatesRunning(parsed)
    queueMicrotask(() => {
      noteAgentTitle(ptyId, running)
      applyOscTitleIfNoAgent(ptyId, opts.workspaceId, panelId, parsed)
    })
  })
  cleanupListeners.push(() => titleDisposable.dispose())

  // Modified special keys + macOS line-editing chords (shared with getOrCreate).
  terminal.attachCustomKeyEventHandler(makeTerminalKeyEventHandler(terminal, ptyId))

  const dataDisposable = terminal.onData((data) => {
    electronAPI.terminalWrite(ptyId, data)
  })
  cleanupListeners.push(() => dataDisposable.dispose())

  const resizeDisposable = terminal.onResize(({ cols, rows }) => {
    electronAPI.terminalResize(ptyId, cols, rows)
  })
  cleanupListeners.push(() => resizeDisposable.dispose())

  electronAPI.shellRegisterTerminal(ptyId).catch((err) => log.warn('[terminal] Shell register failed:', err))
  useStatusStore.getState().registerTerminal(ptyId, opts.workspaceId)

  // panelTransferAck is deferred to attach() — finalizeReconnect() below.
  return entry
}

/**
 * Apply the deferred parts of a cross-window reconnect once attach() has
 * opened+fitted the xterm to its real container: write the captured
 * scrollback at the correct dimensions, then ACK the transfer so main flushes
 * buffered PTY output into a now-correctly-sized buffer.
 */
function finalizeReconnect(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry?.pendingReconnect) return

  const { ptyId, scrollback } = entry.pendingReconnect
  entry.pendingReconnect = undefined

  if (scrollback) {
    entry.terminal.write(scrollback + '\r\n')
  }
  const { electronAPI } = window
  electronAPI
    .panelTransferAck(ptyId)
    .catch((err) => log.warn('[terminal] Transfer ack failed:', err))
}

/**
 * Deposit transfer data for a panel about to be received in this window.
 * Must be called BEFORE React renders the TerminalPanel so that getOrCreate()
 * finds the pending transfer and reconnects instead of spawning a new PTY.
 */
function setPendingTransfer(panelId: string, ptyId: string, scrollback?: string): void {
  pendingTransfers.set(panelId, { ptyId, scrollback })
}

/**
 * Release a terminal from this window's registry without killing the PTY.
 * Used by the source window after a cross-window transfer — the PTY continues
 * to live in the main process, owned by the target window.
 */
function release(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  registry.delete(panelId)
  pendingTransfers.delete(panelId) // stale transfer would hijack a future fresh mount

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

  if (webglAddon) {
    try { webglAddon.dispose() } catch { /* ignore */ }
    entry.webglAddon = null
  }
  if (typeof (fitAddon as unknown as { dispose?: () => void }).dispose === 'function') {
    try { (fitAddon as unknown as { dispose: () => void }).dispose() } catch { /* ignore */ }
  }
  try { terminal.dispose() } catch { /* ignore */ }
}

/**
 * Calls fitAddon.fit() and corrects for sub-pixel overflow.
 *
 * FitAddon calculates rows from getComputedStyle height, which can be
 * fractionally larger than the actual visible area due to calc/flex
 * rounding. When the resulting xterm element is taller than its
 * overflow:hidden container, the bottom row(s) get clipped — but
 * xterm's scrollbar doesn't account for the clipping, so
 * scrollToBottom() leaves content invisible.
 */
function safeFit(terminal: Terminal, fitAddon: FitAddon, container: HTMLElement): void {
  // Coalesce into a single terminal.resize() call so the PTY only receives one
  // SIGWINCH per fit. Two rapid resizes confuse TUI agents (claude code, vim,
  // htop) which redraw their full frame on each SIGWINCH — the second redraw
  // can land at a row index that the first resize had already invalidated,
  // leaving the bottom row clipped from view.
  const proposed = fitAddon.proposeDimensions()
  if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return

  let { cols, rows } = proposed
  cols = Math.max(1, Math.floor(cols))
  rows = Math.max(1, Math.floor(rows))

  // Sub-pixel overflow guard: FitAddon derives rows from getComputedStyle
  // height which can round up past the actual visible (overflow:hidden) area.
  // Probe the cell height by reading any existing row, falling back to a
  // single-resize-then-measure if the terminal hasn't been opened yet.
  const xtermEl = (terminal as unknown as { element?: HTMLElement }).element
  if (xtermEl) {
    const cellHeight = xtermEl.offsetHeight > 0 && terminal.rows > 0
      ? xtermEl.offsetHeight / terminal.rows
      : 0
    if (cellHeight > 0 && rows * cellHeight > container.offsetHeight + 0.5) {
      rows = Math.max(1, rows - 1)
    }
  }

  if (cols !== terminal.cols || rows !== terminal.rows) {
    terminal.resize(cols, rows)
  }

  // Make sure the visible grid and the buffer agree on the new size in a
  // single settled state — refresh the rendered cells and pin the viewport
  // to the bottom so the freshest TUI frame is on screen.
  try {
    terminal.refresh(0, terminal.rows - 1)
    terminal.scrollToBottom()
  } catch { /* ignore */ }
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

  // First-time attach: terminal.open() hasn't been called yet (see
  // getOrCreate). Open directly into the real container so xterm builds its
  // DOM and WebGL canvas with valid layout dimensions from the start.
  let el = (terminal as unknown as { element?: HTMLElement }).element
  if (!el) {
    terminal.open(container)
    el = (terminal as unknown as { element?: HTMLElement }).element
    if (!el) return
  } else {
    // Already attached to this exact container — just re-fit
    if (el.parentElement === container) {
      try { safeFit(terminal, fitAddon, container) } catch { /* ignore */ }
      return
    }

    // Detach from any previous container without disposing
    if (el.parentElement) {
      el.parentElement.removeChild(el)
    }

    container.appendChild(el)
  }

  // Track viewport scroll position continuously so we can restore it on focus.
  // Only add the listener once — attach() may be called many times by the
  // IntersectionObserver visibility toggle, and the xterm DOM tree (including
  // .xterm-viewport) is the same object across reparents. Adding duplicates
  // leaks closures and grows cleanupListeners without bound.
  if (!entry.hasScrollListener) {
    const viewport = el.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) {
      const onScroll = (): void => {
        const e = registry.get(panelId)
        if (e) e.lastScrollTop = viewport.scrollTop
        // Self-heal the bug where the DOM scrollbar reaches the bottom but the
        // xterm buffer's viewportY is one short of baseY (leaving the freshest
        // row invisible). When the user drags the scrollbar all the way down,
        // force the buffer index to match.
        if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2) {
          const current = registry.get(panelId)
          try { current?.terminal.scrollToBottom() } catch { /* ignore */ }
        }
      }
      viewport.addEventListener('scroll', onScroll, { passive: true })
      entry.cleanupListeners.push(() => viewport.removeEventListener('scroll', onScroll))
      entry.hasScrollListener = true
    }
  }

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
  // the sync DOM append (e.g. WebGL canvas initialization).  Retry up to 5
  // frames for new windows that are still settling layout.
  let retries = 0
  function tryFit(): void {
    if (!registry.has(panelId)) return
    if ((container.offsetWidth === 0 || container.offsetHeight === 0) && retries < 5) {
      retries++
      requestAnimationFrame(tryFit)
      return
    }
    fitAndScroll()
  }
  requestAnimationFrame(tryFit)

  function fitAndScroll(): void {
    const liveEntry = registry.get(panelId)
    if (!liveEntry) return
    try {
      // If a scroll position was saved when this panel was last hidden (dock
      // tab switch, IntersectionObserver hide), restore it AFTER fit so the
      // re-shown terminal returns to where the user left it instead of the top.
      // The DOM scrollTop is unreliable here: a fresh appendChild zeroes it, so
      // we restore by buffer line index (captured at detach).
      const saved = liveEntry.savedViewport

      // Use DOM-based scroll check — buffer indices (viewportY/baseY) become
      // stale after fit() changes the row count. Only consulted when there is
      // no saved snapshot (first attach, or a non-detach re-fit).
      const viewport = terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null
      const wasAtBottom = viewport
        ? Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)) < 5
        : true

      safeFit(terminal, fitAddon, container)
      terminal.refresh(0, terminal.rows - 1)

      if (saved) {
        restoreScroll(panelId)
        liveEntry.savedViewport = undefined
      } else if (wasAtBottom) {
        terminal.scrollToBottom()
      }
    } catch { /* ignore */ }

    // Now that the xterm is sized to its real container, replay captured
    // scrollback and release the main-side PTY buffer. Order matters:
    // scrollback first (so visual continuity appears above any flushed
    // PTY output), ack second.
    try { finalizeReconnect(panelId) } catch { /* ignore */ }
  }
}

/**
 * Safely fit the terminal to its current container, correcting for
 * sub-pixel overflow. No-op if the terminal is not attached to a container.
 */
function fit(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const { terminal, fitAddon } = entry
  const el = (terminal as unknown as { element?: HTMLElement }).element
  const container = el?.parentElement
  if (!el || !container) return

  safeFit(terminal, fitAddon, container)
}

/**
 * Snapshot the current buffer viewport position so it can be restored after the
 * xterm element is detached + re-attached (which zeroes the DOM scrollTop) or
 * after fit() changes the row count. Stored as a buffer LINE index plus an
 * at-bottom flag (so a follow-output terminal re-pins to the freshest line
 * rather than a stale index). No-op when there is no scrollback (baseY === 0).
 */
function captureViewport(entry: RegistryEntry): void {
  try {
    const active = entry.terminal.buffer.active
    if (active.baseY <= 0) {
      entry.savedViewport = undefined
      return
    }
    entry.savedViewport = {
      line: active.viewportY,
      atBottom: active.viewportY >= active.baseY,
    }
  } catch {
    /* buffer unavailable mid-dispose — ignore */
  }
}

/**
 * Restore the viewport from the saved buffer line index (captured on detach).
 * Restoring by line index is robust to the scrollTop reset that a DOM reparent
 * causes and to fit()'s row-count change. A follow-output terminal (atBottom)
 * snaps to the freshest line via scrollToBottom(). Falls back to the
 * continuously-tracked pixel scrollTop when no buffer snapshot exists (e.g. a
 * terminal that never had scrollback).
 *
 * Called both from the canvas-focus path (TerminalPanel focus effect) and from
 * attach()'s fitAndScroll() — the latter covers dock tab switches, which never
 * mark the panel as the canvas "focused node".
 */
function restoreScroll(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const saved = entry.savedViewport
  if (saved) {
    try {
      if (saved.atBottom) entry.terminal.scrollToBottom()
      else entry.terminal.scrollToLine(saved.line)
      return
    } catch {
      /* fall through to the pixel-based path below */
    }
  }

  const viewport = (entry.terminal as unknown as { element?: HTMLElement }).element
    ?.querySelector('.xterm-viewport') as HTMLElement | null
  if (viewport && entry.lastScrollTop > 0) {
    viewport.scrollTop = entry.lastScrollTop
  }
}

/**
 * Removes the xterm DOM element from its current container.
 * Does NOT dispose the terminal or kill the PTY — the terminal remains live
 * in the registry and can be re-attached via attach().
 *
 * If `fromContainer` is provided, only detach when the element is currently
 * inside that specific container.  This prevents an unmounting component from
 * tearing the terminal out of a *new* container that already called attach().
 */
function detach(panelId: string, fromContainer?: HTMLElement): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const el = (entry.terminal as unknown as { element?: HTMLElement }).element
  if (!el?.parentElement) return

  if (fromContainer && el.parentElement !== fromContainer) return

  // Save the scroll position BEFORE removing the element. Re-inserting a
  // scrollable element on the next attach() zeroes its scrollTop, so without
  // this snapshot a dock tab switch (unmount → remount) loses the position and
  // the re-shown terminal jumps to the top.
  captureViewport(entry)

  el.parentElement.removeChild(el)
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
  pendingTransfers.delete(panelId) // stale transfer would hijack a future fresh mount

  const { terminal, fitAddon, webglAddon, ptyId, cleanupListeners } = entry
  const { electronAPI } = window

  // Kill PTY and unregister from shell monitor
  if (ptyId) {
    electronAPI.terminalKill(ptyId).catch((err) => log.warn('[terminal] Kill failed:', err))
    electronAPI.shellUnregisterTerminal(ptyId).catch((err) => log.warn('[terminal] Shell unregister failed:', err))
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

/** Returns the last create-failure message for panelId, or null. */
function getFailure(panelId: string): string | null {
  return failures.get(panelId) ?? null
}

/** Subscribe to failure-state changes for any panel. Returns an unsubscribe fn. */
function subscribeFailure(listener: (panelId: string) => void): () => void {
  failureListeners.add(listener)
  return () => failureListeners.delete(listener)
}

/** Returns true if an entry exists for panelId. */
function has(panelId: string): boolean {
  return registry.has(panelId)
}

/**
 * Iterate over every registered terminal. Used by the agent-screen detector
 * to poll each xterm buffer for prompt markers.
 */
function entries(): Array<[string, RegistryEntry]> {
  return Array.from(registry.entries())
}

/** Reverse lookup: find panelId by ptyId. */
function panelIdForPty(ptyId: string): string | null {
  for (const [panelId, entry] of registry) {
    if (entry.ptyId === ptyId) return panelId
  }
  return null
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
  release,
  fit,
  restoreScroll,
  setPendingTransfer,
  getEntry,
  has,
  getFailure,
  subscribeFailure,
  panelIdForPty,
  entries,
  findNext,
  findPrevious,
  clearSearch,
} as const
