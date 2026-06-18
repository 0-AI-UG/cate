// =============================================================================
// cateAgentTerminalExits — records terminal exit codes so the Cate Agent's
// read_terminal tool and the executor's wake logic can report/detect lastExitCode.
// Main fires TERMINAL_EXIT once and forgets it; we keep the last code per ptyId
// here. Its own tiny module so cateAgentTools and cateAgentBridge can both use it
// without an import cycle.
// =============================================================================

const exitByPty = new Map<string, number>()
let subscribed = false

/** Subscribe once to terminal-exit events. Safe to call repeatedly. */
export function initCateAgentTerminalExits(): void {
  if (subscribed) return
  if (typeof window === 'undefined' || !window.electronAPI) return
  subscribed = true
  window.electronAPI.onTerminalExit((ptyId, code) => {
    exitByPty.set(ptyId, code)
  })
}

export function getExitCode(ptyId: string): number | null {
  return exitByPty.has(ptyId) ? (exitByPty.get(ptyId) as number) : null
}

export function clearExit(ptyId: string): void {
  exitByPty.delete(ptyId)
}
