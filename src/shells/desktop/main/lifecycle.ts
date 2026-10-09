// Quitting closes windows and connections only; every runtime then follows
// its `runtimeLifetime` (architecture 15). So the only quit blockers are
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
}

export function createQuitController(deps: QuitDeps): QuitController {
  let confirmed = false
  let committed = false
  let finishing = false
  const show = deps.showMessageBox ?? ((parent, options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)))

  const install = () => {
    app.on('before-quit', (event) => {
      if (committed) return
      event.preventDefault()
      if (finishing) return
      const prompt = confirmed ? null : decideQuitPrompt({ warnBeforeQuit: deps.warnBeforeQuit(), blockers: deps.blockers() })
      if (prompt) {
        void show(deps.parentWindow(), {
          type: 'warning',
          message: prompt.message,
          detail: prompt.detail,
          buttons: ['Quit', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        }).then(({ response }) => {
          if (response !== 0) return
          confirmed = true
          app.quit()
        })
        return
      }
      finishing = true
      void deps.beforeExit()
        .catch((error) => log.warn('quit cleanup failed: %O', error))
        .finally(() => {
          committed = true
          app.quit()
        })
    })
  }

  return { committed: () => committed, install }
}
