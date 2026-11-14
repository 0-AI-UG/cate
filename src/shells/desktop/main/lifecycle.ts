// Quitting closes windows and connections only; every runtime then follows
// its `keepRunningWhile` (architecture 15). So the only quit blockers are
// client-local work (a file drop still importing), which renderers report, and
// the "Warn before quit" setting.

import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { createLogger } from '@kernel/log/contract'

const log = createLogger('lifecycle')

/** The confirmation to show before quitting, or null to quit right away. */
export function decideQuitPrompt(options: { warnBeforeQuit: boolean; blockers: readonly string[] }): { message: string; detail?: string } | null {
  const { blockers } = options
  if (blockers.length > 0) {
    return {
      message: blockers.length === 1 ? `${blockers[0]} is still in progress. Quit anyway?` : `${blockers.length} tasks are still in progress. Quit anyway?`,
      detail: blockers.length > 1 ? blockers.join('\n') : 'It will be stopped. Workspaces keep running.',
    }
  }
  return options.warnBeforeQuit ? { message: 'Quit Cate?' } : null
}

export interface QuitDeps {
  warnBeforeQuit(): boolean
  blockers(): string[]
  parentWindow(): BrowserWindow | undefined
  /** Work before the app goes: flush device files and browser storage, close proxies. */
  beforeExit(): Promise<void>
  showMessageBox?(parent: BrowserWindow | undefined, options: MessageBoxOptions): Promise<{ response: number }>
}

export interface QuitController {
  committed(): boolean
  install(): void
  /** An explicit restart skips the generic quit warning, but still confirms
   *  client-local blockers and flushes the client before invoking an installer. */
  restartForUpdate(install: () => void): Promise<boolean>
  /** An installer error leaves the client running with normal quit checks. */
  cancelUpdateRestart(): void
}

export function createQuitController(deps: QuitDeps): QuitController {
  let committed = false
  let finishing = false
  let updateRestart = false
  const show = deps.showMessageBox ?? ((parent, options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)))

  const finish = async (action: () => void, warn: boolean): Promise<boolean> => {
    if (finishing || committed) return false
    finishing = true
    try {
      const prompt = decideQuitPrompt({ warnBeforeQuit: warn && deps.warnBeforeQuit(), blockers: deps.blockers() })
      if (prompt) {
        const { response } = await show(deps.parentWindow(), {
          type: 'warning',
          message: prompt.message,
          detail: prompt.detail,
          buttons: ['Quit', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        if (response !== 0) return false
      }
      await deps.beforeExit().catch((error) => log.warn('quit cleanup failed: %O', error))
      committed = true
      action()
      return true
    } finally {
      finishing = false
    }
  }

  const install = () => {
    app.on('before-quit', (event) => {
      if (committed) return
      event.preventDefault()
      void finish(() => app.quit(), true).catch((error) => log.warn('quit failed: %O', error))
    })
  }

  return {
    committed: () => committed,
    install,
    // Reply to the renderer before the installer can close its window.
    restartForUpdate: (apply) => finish(() => {
      updateRestart = true
      setImmediate(() => { if (updateRestart) apply() })
    }, false),
    cancelUpdateRestart() {
      if (!updateRestart) return
      updateRestart = false
      committed = false
    },
  }
}
