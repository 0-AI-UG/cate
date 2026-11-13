// The runtime owns history. Live views retain a small tail; the first upward
// scroll or search replaces it with the configured history via process.attach.
import type { Terminal } from '@xterm/xterm'
import type { TerminalBinding } from '@services/terminal/client'

export const LIVE_HISTORY_LINES = 128

export function createTerminalHistory(terminal: Terminal, binding: TerminalBinding, limit: number, onError: (error: unknown) => void) {
  let disposed = false
  let loaded = limit <= LIVE_HISTORY_LINES
  let loading: Promise<void> | null = null
  const load = (): Promise<void> => {
    if (loading) return loading
    if (loaded || disposed) return Promise.resolve()
    // Capture at the parser barrier, so gestures during a remote attach wait
    // are included. Text anchors account for output arriving after detaching;
    // a length delta alone would shift selections onto newer output.
    const capture = () => {
      const b = terminal.buffer.active
      const selection = terminal.getSelectionPosition()
      return {
        distance: b.baseY - b.viewportY, length: b.length, viewportY: b.viewportY,
        viewportText: b.getLine(b.viewportY)?.translateToString(), selection,
        selectedText: terminal.getSelection(),
        selectionText: selection && b.getLine(selection.start.y)?.translateToString(),
      }
    }
    let anchor = capture()
    terminal.options.scrollback = limit
    loading = binding.setScrollback(limit, () => { anchor = capture() }).then(() => {
      if (disposed) return
      loaded = true
      const next = terminal.buffer.active
      const delta = next.length - anchor.length
      const rowFor = (row: number, text: string | undefined): number | null => {
        if (text === undefined) return null
        const expected = row + delta
        // Usually the same row, or a few heartbeat rows away. Search nearest
        // first rather than translating the whole configured history.
        for (let offset = 0; offset < next.length; offset++) {
          const before = expected - offset
          const after = expected + offset
          if (before >= 0 && before < next.length && next.getLine(before)?.translateToString() === text) return before
          if (offset > 0 && after >= 0 && after < next.length && next.getLine(after)?.translateToString() === text) return after
        }
        return null
      }
      terminal.scrollToLine(rowFor(anchor.viewportY, anchor.viewportText) ?? Math.max(0, next.baseY - anchor.distance))
      const selection = anchor.selection
      if (selection) {
        const start = rowFor(selection.start.y, anchor.selectionText)
        if (start !== null) {
          terminal.select(selection.start.x, start, (selection.end.y - selection.start.y) * terminal.cols + selection.end.x - selection.start.x)
        }
        // Matching the first row cannot identify a repeated multi-line block.
        // Never leave a selection that would copy different text after reset.
        if (start === null || terminal.getSelection() !== anchor.selectedText) terminal.clearSelection()
      }
    }).finally(() => { loading = null })
    return loading
  }
  const requestHistory = () => {
    const b = terminal.buffer.active
    if (b.type === 'normal' && b.viewportY < b.baseY) void load().catch(onError)
  }
  const scroll = terminal.onScroll(requestHistory)
  // xterm suppresses its public onScroll event for viewport-originated moves
  // (wheel and scrollbar). Its native handler updates the buffer first.
  const viewport = terminal.element?.querySelector('.xterm-viewport')
  viewport?.addEventListener('scroll', requestHistory)
  return {
    load,
    dispose() { disposed = true; scroll.dispose(); viewport?.removeEventListener('scroll', requestHistory) },
  }
}
