// The workspace views the client registers into the slots other modules own:
// the application overlays (skills, repository, usage), tab decorations and
// panel chrome overlays, canvas toolbar items, the canvas and relation slots.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { clientUi } from '@kernel/interaction'
import { newPanelActionId, panelTypeOpening } from '@client/host'
import { registerPanelChromeOverlay, registerTabDecorations } from '../../client/layout/dock'
import {
  CanvasToolbarButton,
  createPanelOnCanvas,
  registerCanvasToolbarItem,
  useCanvasToolbarAction,
  type CanvasToolbarAction,
  type CanvasToolbarItemProps,
} from '../../client/layout/canvas'
import { AgentChangesOverlay, AgentHooksOffOverlay, useAgentContextTransport, useAgentTabDecorations } from '../../services/agents'
import { t3Conversations } from '@services/t3/client'
import { T3ConversationMenu, UsageOverview } from '../../services/t3'
import { SkillsDialog } from '../../workspace/skills'
import {
  RepositoryOverview,
  WorktreePill,
  WorktreeToolbarMenu,
  useRepositoryUi,
  type RepositoryTab,
} from '../../workspace/repository'
import { openPullRequest, pullRequestNotOpenMessage } from '@workspace/repository/client'
import { PanelRelationContextToggle, installRelationUiPort } from '../../workspace/relations'
import type { PanelRecord } from '@workspace/document/contract'
import { OverlayHeader } from '../chrome/chrome'
import { registerOverlay, type OverlayViewProps } from '../overlays'
import { openTextPreview } from './textPreview'

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
  const conversationType = panelTypeOpening('conversation')
  return (
    <span ref={box} className="contents">
    <T3ConversationMenu
      menuSide={menuSide}
      newAction={conversationType ? newPanelActionId(conversationType) : undefined}
      onOpenChange={onOpenChange}
      renderTrigger={({ ref, onClick, active, icon }) => (
        <CanvasToolbarButton ref={ref} onClick={onClick} active={active} action="openConversationMenu" label="T3 Code conversations" tooltipPlacement={tooltipPlacement}>
          {icon}
        </CanvasToolbarButton>
      )}
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

// --- Registration -----------------------------------------------------------------

/** Registers the workspace views once per window; returns the undo. */
export function registerWorkspaceViews(): () => void {
  installRelationUiPort({
    showMenu: async (items) => (await clientUi().showContextMenu?.(items.map((item) => (item.type === 'separator' ? { type: 'separator' } : { id: item.id, label: item.label, enabled: item.enabled })))) ?? null,
    useContextTransport: useAgentContextTransport,
    openTextPreview: ({ title, content }) => openTextPreview({ title, content }),
  })
  const stops = [
    registerOverlay('skills', SkillsOverlay),
    registerOverlay('pullRequests', RepositoryOverlay),
    registerOverlay('usage', UsageOverlay),
    registerTabDecorations(useAgentTabDecorations),
    registerPanelChromeOverlay(WorktreeChip),
    registerPanelChromeOverlay(RelationToggle),
    registerPanelChromeOverlay(AgentChangesOverlay),
    registerPanelChromeOverlay(AgentHooksOffOverlay),
    registerCanvasToolbarItem({ id: 'worktrees', group: 'tools', order: 10, Component: WorktreeToolbarItem }),
    registerCanvasToolbarItem({ id: 't3-conversations', group: 'create', order: 90, Component: ConversationsToolbarItem }),
  ]
  return () => {
    for (const stop of stops.splice(0)) stop()
    installRelationUiPort(null)
  }
}
