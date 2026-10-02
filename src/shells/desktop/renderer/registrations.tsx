// What the desktop renderer registers into the slots other modules own, once
// per window before the first render: every panel view, the client's
// workspace views, the review and agent changes openers, file drops, native
// window actions, the menu bar sync and the desktop settings pages.

import { SettingRow, Toggle, clientUi } from '@kernel/ui'
import { setClientSetting, useClientSetting } from '@kernel/settings/ui'
import { defineActions, storedShortcut } from '@kernel/ui/contract'
import { registerActions } from '@client/host'
import { installFileDropHandler } from '@client/layout/drag'
import { installReviewOpener, openDroppedFiles, registerSettingsPage, registerWorkspaceViews } from '@client/ui'
import { setAgentChangesOpener } from '@services/agents/ui'
import { openAgentChanges, openReviewPanel } from '@panels/review/view'
import type { DesktopApi, NativeAction } from '../contract'
import { quitBlockers } from './quitBlockers'
import { syncMenuModel } from './menuModel'

// Every panel view registers itself on import.
import '@panels/terminal/view'
import '@panels/editor/view'
import '@panels/browser/view'
import '@panels/chat/view'
import '@panels/review/view'
import '@panels/canvas/view'
import '@panels/surface/view'

// --- Desktop settings pages -------------------------------------------------------

function GeneralPage() {
  const warnBeforeQuit = useClientSetting('warnBeforeQuit')
  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Warn before quit" description="Ask before quitting with Cmd+Q">
        <Toggle checked={warnBeforeQuit} onChange={(v) => setClientSetting('warnBeforeQuit', v)} />
      </SettingRow>
      <SettingRow
        label="Privacy"
        description="Cate collects anonymous usage data and crash reports to improve the app. No file paths, project names, or personal data."
      >
        <button
          type="button"
          onClick={() => clientUi().openExternal('https://cate.cero-ai.com/privacy')}
          className="text-blue-400 hover:text-blue-300 text-[12px] font-medium whitespace-nowrap"
        >
          Privacy Policy
        </button>
      </SettingRow>
    </div>
  )
}

function UpdatesPage() {
  const beta = useClientSetting('betaUpdatesEnabled')
  const gpu = useClientSetting('disableGpuRasterization')
  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Receive beta builds"
        description="Get early access to less stable pre-release builds. Turning this off keeps any beta you've installed until stable catches up."
      >
        <Toggle checked={beta} onChange={(v) => setClientSetting('betaUpdatesEnabled', v)} />
      </SettingRow>
      <SettingRow label="Disable GPU rasterization" description="Works around garbled text on some GPUs. Applies after a restart.">
        <Toggle checked={gpu} onChange={(v) => setClientSetting('disableGpuRasterization', v)} />
      </SettingRow>
    </div>
  )
}

// --- Window actions ---------------------------------------------------------------

/** What the main process runs for this window. */
const WINDOW_ACTIONS = defineActions({
  newWindow: { title: 'New Window', key: storedShortcut('n', { command: true, shift: true }), menu: { bar: 'file', group: 'window' } },
  closeWindow: { title: 'Close Window', key: storedShortcut('w', { command: true, shift: true }), menu: { bar: 'file', group: 'close', order: 1 } },
  showMainWindow: { title: 'Main Window', menu: { bar: 'window', group: 'main' } },
  toggleFullscreen: { title: 'Toggle Full Screen', key: storedShortcut('f', { command: true, control: true }), menu: { bar: 'view', group: 'window' } },
  reloadWindow: { title: 'Force Reload Window', menu: { bar: 'view', group: 'dev' } },
  toggleDevTools: { title: 'Toggle Developer Tools', key: storedShortcut('i', { command: true, option: true }), menu: { bar: 'view', group: 'dev' } },
  documentation: { title: 'Cate Documentation', menu: { bar: 'help', group: 'links' } },
  reportIssue: { title: 'Report Issue…', menu: { bar: 'help', group: 'links' } },
})

// --- Registration -----------------------------------------------------------------

export function registerDesktopRenderer(api: DesktopApi): () => void {
  installReviewOpener(openReviewPanel)
  installFileDropHandler({
    openFiles: openDroppedFiles,
    // A copy is client-local work: quitting waits for it.
    importing(_workspaceId, done) {
      const release = quitBlockers.hold('Copying dropped files')
      void done.then(release, release)
    },
  })
  const native = (action: NativeAction) => ({ run: () => api.menu.runNativeAction(action) })
  const stops = [
    registerWorkspaceViews(),
    registerActions(WINDOW_ACTIONS, {
      newWindow: native('newWindow'),
      closeWindow: native('closeWindow'),
      showMainWindow: native('showMainWindow'),
      toggleFullscreen: native('toggleFullscreen'),
      reloadWindow: native('reloadWindow'),
      toggleDevTools: native('toggleDevTools'),
      documentation: native('documentation'),
      reportIssue: native('reportIssue'),
    }),
    syncMenuModel(api),
    setAgentChangesOpener((request) => openAgentChanges(request)),
    registerSettingsPage({ id: 'general', title: 'General', group: 'general', scope: 'client', order: 0, component: GeneralPage }),
    registerSettingsPage({ id: 'updates', title: 'Updates', group: 'general', scope: 'client', order: 90, component: UpdatesPage }),
  ]
  return () => {
    for (const stop of stops.splice(0)) stop()
    installReviewOpener(null)
    installFileDropHandler(null)
  }
}
