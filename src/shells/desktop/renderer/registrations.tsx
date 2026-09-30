// What the desktop renderer registers into the slots other modules own, once
// per window before the first render: every panel view, the application
// overlays, tab decorations and panel chrome overlays, canvas toolbar items,
// the relation and canvas slots, file routing and the desktop settings pages.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { SettingRow, Toggle, clientUi } from '@kernel/ui'
import { setClientSetting, useClientSetting } from '@kernel/settings/ui'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { panelTypeOpening, registerPanelDefinitions } from '@client/host'
import {
  AgentChangesOverlay,
  registerPanelChromeOverlay,
  registerTabDecorations,
  useAgentTabDecorations,
} from '@client/layout/dock'
import { CanvasToolbarButton, installCanvasSlots, installMinimapBadges, registerCanvasToolbarItem, useCanvasToolbarAction, type CanvasToolbarAction, type CanvasToolbarItemProps, type NodeActivity } from '@client/layout/canvas'
import { installFileDropHandler } from '@client/layout/drag'
import { OverlayHeader, bindActions, installFileOpener, registerOverlay, registerSettingsPage, type OverlayViewProps } from '@client/ui'
import { AGENT_DEFS } from '@services/agents/contract'
import { setAgentChangesOpener, useAgentInfoByPanel, useAgentPanelInfo, useAgentPanelState } from '@services/agents/ui'
import { t3Conversations } from '@services/t3/client'
import { T3ConversationMenu, UsageOverview } from '@services/t3/ui'
import { SkillsDialog } from '@workspace/skills/ui'
import {
  RepositoryOverview,
  WorktreePill,
  WorktreeToolbarMenu,
  openPullRequest,
  pullRequestNotOpenMessage,
  useRepositoryUi,
  type RepositoryTab,
} from '@workspace/repository/ui'
import { PanelRelationContextToggle, installRelationUiPort } from '@workspace/relations/ui'
import type { PanelRecord } from '@workspace/document/contract'
import { createPanelOnCanvas } from '@client/layout/canvas'
import { openAgentChanges } from '@panels/review/view'
import type { DesktopApi, NativeAction } from '../contract'
import { openDroppedFiles, openFile } from './fileActions'
import { quitBlockers } from './quitBlockers'
import { openTextPreview } from './textPreview'

// Every panel view registers itself on import.
import '@panels/terminal/view'
import '@panels/editor/view'
import '@panels/browser/view'
import '@panels/chat/view'
import '@panels/review/view'
import '@panels/canvas/view'
import '@panels/surface/view'

// --- Overlays --------------------------------------------------------------------

/** Application overlays draw over the content area (next to settings). */
function ContentOverlay({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => setSlot(document.getElementById('settings-content-slot')), [])
  const body = <div className="absolute inset-0 flex flex-col bg-canvas-bg pointer-events-auto">{children}</div>
  return slot ? createPortal(body, slot) : body
}

function SkillsOverlay({ workspaceId, onClose }: OverlayViewProps) {
  return (
    <ContentOverlay>
      <SkillsDialog workspaceId={workspaceId} onClose={onClose} renderHeader={(actions) => <OverlayHeader title="Skills">{actions}</OverlayHeader>} />
    </ContentOverlay>
  )
}

function RepositoryOverlay({ workspaceId }: OverlayViewProps) {
  const [tab, setTab] = useState<RepositoryTab>('changes')
  if (!workspaceId) return <ContentOverlay><OverlayHeader title="Repository" /></ContentOverlay>
  return (
    <ContentOverlay>
      <RepositoryPane workspaceId={workspaceId} tab={tab} onTabChange={setTab} />
    </ContentOverlay>
  )
}

function RepositoryPane({ workspaceId, tab, onTabChange }: { workspaceId: string; tab: RepositoryTab; onTabChange(tab: RepositoryTab): void }) {
  const host = useRepositoryUi()
  return (
    <RepositoryOverview
      tab={tab}
      onTabChange={onTabChange}
      header={(actions) => <OverlayHeader title="Repository">{actions}</OverlayHeader>}
      onOpenPullRequest={async (pr) => {
        const runtime = tryRuntimeFor(workspaceId)
        if (!runtime || !(await openPullRequest(pr, host, runtime))) clientUi().showError(pullRequestNotOpenMessage(pr))
      }}
    />
  )
}

function UsageOverlay({ workspaceId }: OverlayViewProps) {
  return (
    <ContentOverlay>
      <UsageOverview workspaceId={workspaceId} visible header={<OverlayHeader title="Usage" />} />
    </ContentOverlay>
  )
}

// --- Panel chrome and canvas toolbar -------------------------------------------------

const WorktreeChip = ({ record }: { workspaceId: string; record: PanelRecord }) => <WorktreePill panel={record} />
const RelationToggle = ({ workspaceId, record }: { workspaceId: string; record: PanelRecord }) => (
  <PanelRelationContextToggle workspaceId={workspaceId} panel={record} />
)

/** Opens a toolbar item's menu from its shortcut by clicking its trigger. */
function useShortcutTrigger(action: CanvasToolbarAction, canvasPanelId: string) {
  const box = useRef<HTMLSpanElement>(null)
  useCanvasToolbarAction(action, canvasPanelId, () => box.current?.querySelector('button')?.click())
  return box
}

function WorktreeToolbarItem({ canvasPanelId, menuSide, tooltipPlacement, onOpenChange }: CanvasToolbarItemProps) {
  const box = useShortcutTrigger('openWorktreeMenu', canvasPanelId)
  return (
    <span ref={box} className="contents">
    <WorktreeToolbarMenu
      canvasPanelId={canvasPanelId}
      menuSide={menuSide}
      onOpenChange={onOpenChange}
      renderTrigger={({ ref, onClick, active, icon }) => (
        <CanvasToolbarButton ref={ref} onClick={onClick} active={active} label="Worktrees" tooltipPlacement={tooltipPlacement}>
          {icon}
        </CanvasToolbarButton>
      )}
    />
    </span>
  )
}

function ConversationsToolbarItem({ workspaceId, canvasId, canvasPanelId, menuSide, tooltipPlacement, onOpenChange }: CanvasToolbarItemProps) {
  const box = useShortcutTrigger('openConversationMenu', canvasPanelId)
  return (
    <span ref={box} className="contents">
    <T3ConversationMenu
      menuSide={menuSide}
      tooltipPlacement={tooltipPlacement}
      onOpenChange={onOpenChange}
      target={() => {
        const runtime = tryRuntimeFor(workspaceId)
        if (!runtime) return null
        return {
          conversations: t3Conversations(runtime.t3, undefined),
          open: (thread) => {
            const type = panelTypeOpening('conversation')
            if (type) createPanelOnCanvas(workspaceId, canvasId, type, thread ? { threadId: thread.id } : {})
          },
        }
      }}
    />
    </span>
  )
}

// --- Canvas and relation slots ------------------------------------------------------

function useNodeActivity(workspaceId: string, panelId: string | null): NodeActivity | undefined {
  const info = useAgentPanelInfo(workspaceId, panelId ?? '')
  if (!panelId || !info) return undefined
  if (info.status === 'waitingForInput') return 'waiting'
  if (info.status === 'finished') return 'finished'
  return undefined
}

function useContextTransport(workspaceId: string, panel: PanelRecord) {
  const state = useAgentPanelState(workspaceId, panel.id)
  if (!state) return null
  if (state.runner === 't3') return { decorate: (text: string) => text }
  const def = state.agentId ? AGENT_DEFS[state.agentId] : undefined
  if (!def?.promptContextHook) return null
  const guidance = def.promptGuidance
  return { decorate: (text: string) => (guidance ? `${guidance}\n\n${text}` : text) }
}

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

// --- Registration -----------------------------------------------------------------

export function registerDesktopRenderer(api: DesktopApi): () => void {
  registerPanelDefinitions(PANEL_DEFINITIONS)
  installCanvasSlots({ useNodeActivity })
  installMinimapBadges(useAgentInfoByPanel)
  installRelationUiPort({
    showMenu: (items) => api.menu.showContextMenu(items.map((item) => (item.type === 'separator' ? { type: 'separator' } : { id: item.id, label: item.label, enabled: item.enabled }))),
    useContextTransport,
    openTextPreview: ({ title, content }) => openTextPreview({ title, content }),
  })
  installFileOpener((workspaceId, path) => { openFile(workspaceId, path) })
  installFileDropHandler({
    openFiles: openDroppedFiles,
    async importDestination(workspaceId) {
      const runtime = tryRuntimeFor(workspaceId)
      if (!runtime) return null
      return (await runtime.workspace.info()).root
    },
    // An import is client-local work: quitting waits for it.
    importing(_workspaceId, done) {
      const release = quitBlockers.hold('Importing dropped files')
      void done.then(release, release)
    },
  })
  const native = (action: NativeAction) => ({ run: () => api.menu.runNativeAction(action) })
  const stops = [
    // Window actions the shell's main process runs.
    bindActions({
      newWindow: native('newWindow'),
      closeWindow: native('closeWindow'),
      toggleFullscreen: native('toggleFullscreen'),
      reloadWindow: native('reloadWindow'),
      toggleDevTools: native('toggleDevTools'),
      documentation: native('documentation'),
      reportIssue: native('reportIssue'),
    }),
    registerOverlay('skills', SkillsOverlay),
    registerOverlay('pullRequests', RepositoryOverlay),
    registerOverlay('usage', UsageOverlay),
    registerTabDecorations(useAgentTabDecorations),
    registerPanelChromeOverlay(WorktreeChip),
    registerPanelChromeOverlay(RelationToggle),
    registerPanelChromeOverlay(AgentChangesOverlay),
    registerCanvasToolbarItem({ id: 'worktrees', group: 'tools', order: 10, Component: WorktreeToolbarItem }),
    registerCanvasToolbarItem({ id: 't3-conversations', group: 'create', order: 90, Component: ConversationsToolbarItem }),
    setAgentChangesOpener((request) => openAgentChanges(request)),
    registerSettingsPage({ id: 'general', title: 'General', group: 'general', scope: 'client', order: 0, component: GeneralPage }),
    registerSettingsPage({ id: 'updates', title: 'Updates', group: 'general', scope: 'client', order: 90, component: UpdatesPage }),
  ]
  return () => {
    for (const stop of stops.splice(0)) stop()
    installFileOpener(null)
    installFileDropHandler(null)
    installRelationUiPort(null)
    installMinimapBadges(null)
  }
}
