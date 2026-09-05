import { ChatsCircle, Gear, Plus } from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'
import { useActivePanelStore } from '../lib/activePanel'
import { revealPanel } from '../lib/workspace/panelReveal'
import { useOtherWindowPanels } from '../stores/windowPanelStore'
import { useUIStore } from '../stores/uiStore'
import { Tooltip } from '../ui/Tooltip'

interface AgentSidebarViewProps {
  workspaceId: string
}

export function AgentSidebarView({ workspaceId }: AgentSidebarViewProps) {
  const workspace = useAppStore((state) => state.workspaces.find((item) => item.id === workspaceId))
  const activePanelId = useActivePanelStore((state) => state.activePanelId)
  const localPanels = Object.values(workspace?.panels ?? {}).filter((panel) => panel.type === 'agent')
  const otherPanels = useOtherWindowPanels(workspaceId, Object.keys(workspace?.panels ?? {}))
    .filter((panel) => panel.type === 'agent')

  const createThread = (): void => {
    if (!workspaceId || !workspace?.rootPath) return
    useAppStore.getState().createAgent(workspaceId)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-2">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle px-3">
        <ChatsCircle size={15} className="text-[rgb(var(--agent-rgb))]" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">Agent threads</span>
        <Tooltip label="Provider settings">
          <button
            type="button"
            onClick={() => useUIStore.getState().openSettings('agent')}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary"
            aria-label="Provider settings"
          >
            <Gear size={13} />
          </button>
        </Tooltip>
        <Tooltip label="New agent thread">
          <button
            type="button"
            onClick={createThread}
            disabled={!workspace?.rootPath}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-40"
            aria-label="New agent thread"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {localPanels.length === 0 && otherPanels.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center">
            <ChatsCircle size={26} className="mb-2 text-muted" />
            <p className="text-sm text-secondary">No agent threads</p>
            <p className="mt-1 text-xs text-muted">Start a thread for this workspace.</p>
            <button
              type="button"
              onClick={createThread}
              disabled={!workspace?.rootPath}
              className="mt-3 inline-flex items-center gap-1.5 rounded bg-surface-5 px-3 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
            >
              <Plus size={13} />
              New thread
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {localPanels.map((panel) => {
              const worktree = workspace?.worktrees?.find((item) => item.id === panel.worktreeId)
              const cwd = panel.cwd ?? worktree?.path ?? workspace?.rootPath
              return (
                <button
                  key={panel.id}
                  type="button"
                  onClick={() => { void revealPanel(workspaceId, panel.id, { retry: true }) }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    activePanelId === panel.id ? 'bg-surface-5 text-primary' : 'text-secondary hover:bg-hover hover:text-primary'
                  }`}
                >
                  <ChatsCircle size={14} className="shrink-0 text-[rgb(var(--agent-rgb))]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{panel.title}</span>
                    {cwd && <span className="mt-0.5 block truncate text-[10px] text-muted">{cwd}</span>}
                  </span>
                </button>
              )
            })}
            {otherPanels.map((panel) => (
              <button
                key={panel.panelId}
                type="button"
                onClick={() => { void window.electronAPI.focusWindowPanel(panel.panelId) }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-secondary transition-colors hover:bg-hover hover:text-primary"
                title="Open in its current window"
              >
                <ChatsCircle size={14} className="shrink-0 text-[rgb(var(--agent-rgb))]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{panel.title}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted">Other window</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
