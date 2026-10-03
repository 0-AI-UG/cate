// The xterm of one terminal view: renderer, addons, links, keymaps and OSC 52.
// Bytes come from `bindTerminal`; this module only builds and sizes it.

import { Terminal, type ITheme } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { createFileLinkProvider, type FileLinkPorts } from './fileLinkProvider'
import { makeTerminalKeyEventHandler } from './input'
import { registerOsc52ClipboardHandler, type ClipboardWriter } from './osc52'
import type { TerminalOptionsFromSettings } from './settings'

/** Chromium caps live WebGL contexts per GPU process; terminals past this
 *  many per client stay on xterm's DOM renderer, which always paints. */
const MAX_WEBGL_TERMINALS = 6
let webglTerminals = 0

export interface TerminalXtermOptions {
  options: TerminalOptionsFromSettings
  theme: ITheme
  isMac: boolean
  onUrl(event: MouseEvent, url: string): void
  fileLinks: FileLinkPorts
  /** Present on clients with `clipboard`. */
  clipboard?: ClipboardWriter
}

export interface TerminalXterm {
  readonly terminal: Terminal
  readonly search: SearchAddon
  open(parent: HTMLElement): void
  /** The grid a box holds (layout px, the parent's coordinates) at the
   *  current font, or null before the first render. */
  gridFor(box: { width: number; height: number }): { cols: number; rows: number } | null
  /** The box (layout px) that holds the terminal's grid exactly. */
  gridBox(): { width: number; height: number } | null
  /** Re-measures the scrollbar width xterm caches at construction. */
  syncScrollBarWidth(): void
  setOptions(options: Partial<TerminalOptionsFromSettings> & { theme?: ITheme }): void
  isAtBottom(): boolean
  /** Drops the WebGL renderer for good and repaints on the DOM renderer, for
   *  a garbled GPU atlas. */
  resetRendering(): void
  dispose(): void
}

export function createTerminalXterm(config: TerminalXtermOptions): TerminalXterm {
  const terminal = new Terminal({
    ...config.options,
    theme: config.theme,
    allowProposedApi: true,
    scrollback: 5000,
    altClickMovesCursor: true,
  })
  const search = new SearchAddon()
  terminal.loadAddon(search)
  terminal.loadAddon(new WebLinksAddon(config.onUrl))
  const cleanups: Array<() => void> = []
  const fileLinks = terminal.registerLinkProvider(createFileLinkProvider(terminal, config.fileLinks, config.isMac))
  cleanups.push(() => fileLinks.dispose())
  // `input` fires onData, so these bytes reach the PTY through the binding.
  terminal.attachCustomKeyEventHandler(makeTerminalKeyEventHandler(terminal, (data) => terminal.input(data, true), config.isMac))
  if (config.clipboard) cleanups.push(registerOsc52ClipboardHandler(terminal, config.clipboard))

  let webgl: { dispose(): void } | null = null
  let webglLost = false
  let disposed = false

  const enableWebgl = async () => {
    if (webgl || webglLost || webglTerminals >= MAX_WEBGL_TERMINALS) return
    webglTerminals++
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      if (disposed) throw new Error('disposed')
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // Re-acquiring just loses it again: stay on the DOM renderer.
        webglLost = true
        releaseWebgl()
        try { terminal.refresh(0, terminal.rows - 1) } catch { /* disposed */ }
      })
      terminal.loadAddon(addon)
      webgl = addon
    } catch {
      webglLost = true
      webglTerminals--
    }
  }
  // The cell xterm renders (layout px) and the scrollbar track it reserves,
  // as FitAddon reads them.
  const core = () => (terminal as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } }; viewport?: { scrollBarWidth?: number } }
  })._core
  const cellSize = () => {
    const cell = core()?._renderService?.dimensions?.css?.cell
    return cell && cell.width > 0 && cell.height > 0 ? cell : null
  }
  const scrollBarWidth = () => (terminal.options.scrollback === 0 ? 0 : core()?.viewport?.scrollBarWidth ?? 0)

  const releaseWebgl = () => {
    if (!webgl) return
    try { webgl.dispose() } catch { /* already gone */ }
    webgl = null
    webglTerminals--
  }

  return {
    terminal,
    search,
    open(parent) {
      if (terminal.element) {
        if (terminal.element.parentElement !== parent) parent.appendChild(terminal.element)
        return
      }
      terminal.open(parent)
      void enableWebgl()
    },
    gridFor(box) {
      const cell = cellSize()
      if (!cell || box.width <= 0 || box.height <= 0) return null
      return {
        cols: Math.max(1, Math.floor((box.width - scrollBarWidth()) / cell.width)),
        // Rounded down so the bottom row, the freshest TUI frame, is never clipped.
        rows: Math.max(1, Math.floor(box.height / cell.height)),
      }
    },
    gridBox() {
      const cell = cellSize()
      if (!cell) return null
      return { width: terminal.cols * cell.width + scrollBarWidth(), height: terminal.rows * cell.height }
    },
    syncScrollBarWidth() {
      const viewport = terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null
      if (!viewport) return
      const measured = viewport.offsetWidth - viewport.clientWidth
      // 0 means no track right now; keep the last good value.
      if (measured <= 0 || measured > 200) return
      const core = (terminal as unknown as { _core?: { viewport?: { scrollBarWidth?: number } } })._core
      if (core?.viewport && typeof core.viewport.scrollBarWidth === 'number') core.viewport.scrollBarWidth = measured
    },
    setOptions(options) {
      for (const [key, value] of Object.entries(options)) {
        const current = (terminal.options as Record<string, unknown>)[key]
        if (current !== value) (terminal.options as Record<string, unknown>)[key] = value
      }
    },
    isAtBottom() {
      const buffer = terminal.buffer.active
      return buffer.viewportY >= buffer.baseY
    },
    resetRendering() {
      webglLost = true
      releaseWebgl()
      try { terminal.refresh(0, terminal.rows - 1) } catch { /* disposed */ }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const cleanup of cleanups) {
        try { cleanup() } catch { /* terminal already torn down */ }
      }
      releaseWebgl()
      disposeXtermTerminal(terminal)
    },
  }
}

function disposeXtermTerminal(terminal: Terminal): void {
  // xterm 5.5's CoreBrowserService creates ScreenDprMonitor without registering
  // it for disposal. Its window resize and MediaQueryList listeners otherwise
  // retain a monitor for every closed terminal. Remove this workaround when
  // upgrading to an xterm version that owns the monitor's lifetime.
  const core = (terminal as unknown as {
    _core?: { _coreBrowserService?: { _screenDprMonitor?: { dispose(): void } } }
  })._core
  try {
    core?._coreBrowserService?._screenDprMonitor?.dispose()
  } finally {
    terminal.dispose()
  }
}
