// The settings pages ui/app registers at start: its own slices, the pages
// of the modules below it (kernel/api, runtime/daemon, workspace/repository,
// workspace/skills, services/agents with services/t3's providers) and the pages it hosts for slice owners
// without a page of their own yet (kernel/interaction, ui/client/layout,
// services/terminal, services/browser, panels/editor). The desktop shell
// registers General and Updates itself.

import { CliSettingsPage } from '../../kernel/api'
import { workspaceSettingsFor } from '../../kernel/settings'
import { RuntimeSettingsPage } from '../../runtime/daemon'
import { GitHubSettings, WorktreeSettings } from '../../workspace/repository'
import { SkillsSettings } from '../../workspace/skills'
import { useRuntime } from '../../kernel/rpc'
import { T3_AGENTS } from '@services/agents/contract'
import { AgentHooksSettings, AgentSettings, agentLogo } from '../../services/agents'
import type { T3ProviderId } from '@services/t3/contract'
import { T3Providers } from '../../services/t3'
import { documentStoreFor } from '@client/document'
import { openUrlInPanel } from '@client/host'
import { useUIStore } from '../state/uiStore'
import { tryClientApp } from '../app'
import { DevicesPage } from '../pairing/DevicesPage'
import { RemoteMachinesPage } from '../remote/RemoteMachinesPage'
import { ConnectionNotice } from '../sidebar/connectionStatus'
import { AppearancePage } from './pages/AppearancePage'
import { CanvasPage } from './pages/CanvasPage'
import { ShortcutsPage } from './pages/ShortcutsPage'
import { BrowserPage, EditorPage, NotificationsPage, SidebarPage, TerminalPage } from './pages/clientPages'
import { registerSettingsPage, type SettingsPage, type SettingsPageProps } from './registry'

function RuntimePage({ workspaceId }: SettingsPageProps): JSX.Element | null {
  if (!workspaceId) return null
  const connection = tryClientApp()?.connections.get(workspaceId)
  return (
    <RuntimeSettingsPage
      workspaceId={workspaceId}
      panelTitle={(panelId) => documentStoreFor(workspaceId)?.getSnapshot().panels[panelId]?.title}
    >
      <ConnectionNotice connection={connection} />
    </RuntimeSettingsPage>
  )
}

function WorktreesPage({ workspaceId }: SettingsPageProps): JSX.Element | null {
  const settings = workspaceId ? workspaceSettingsFor(workspaceId) : null
  return settings ? <WorktreeSettings settings={settings} /> : null
}

function GitHubPage({ workspaceId }: SettingsPageProps): JSX.Element | null {
  if (!workspaceId) return null
  return <GitHubSettings workspaceId={workspaceId} onShowPullRequests={() => useUIStore.getState().openOverlay({ view: 'pullRequests' })} />
}

function SkillsPage({ workspaceId }: SettingsPageProps): JSX.Element | null {
  return workspaceId ? <SkillsSettings workspaceId={workspaceId} /> : null
}

const t3ProviderLogo = (providerId: T3ProviderId): string | undefined =>
  agentLogo(T3_AGENTS.find((agent) => agent.runners.t3.providerId === providerId)?.id) ?? undefined

function AgentsPage({ workspaceId }: SettingsPageProps): JSX.Element {
  const runtime = useRuntime(workspaceId)
  return <AgentSettings providers={<T3Providers t3={runtime?.t3 ?? null} providerLogo={t3ProviderLogo} openInWorkspace={(url) => openUrlInPanel(workspaceId, url)} />} />
}

function HooksPage({ workspaceId }: SettingsPageProps): JSX.Element {
  return <AgentHooksSettings workspaceId={workspaceId} />
}

export const DEFAULT_SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'appearance', title: 'Appearance', group: 'general', scope: 'client', order: 10, component: AppearancePage },
  { id: 'notifications', title: 'Notifications', group: 'general', scope: 'client', order: 20, component: NotificationsPage },
  { id: 'remote-machines', title: 'Remote machines', group: 'general', scope: 'client', order: 30, component: RemoteMachinesPage },
  { id: 'canvas', title: 'Canvas', group: 'workspace', scope: 'client', order: 10, component: CanvasPage },
  { id: 'sidebar', title: 'Sidebar', group: 'workspace', scope: 'client', order: 20, component: SidebarPage },
  { id: 'runtime', title: 'Runtime', group: 'workspace', scope: 'workspace', order: 30, component: RuntimePage },
  { id: 'devices', title: 'Devices', group: 'workspace', scope: 'workspace', order: 40, component: DevicesPage },
  { id: 'worktrees', title: 'Worktrees', group: 'workspace', scope: 'workspace', order: 50, component: WorktreesPage },
  { id: 'terminal', title: 'Terminal', group: 'tools', scope: 'client', order: 10, component: TerminalPage },
  { id: 'browser', title: 'Browser', group: 'tools', scope: 'client', order: 20, component: BrowserPage },
  { id: 'editor', title: 'Editor', group: 'tools', scope: 'client', order: 30, component: EditorPage },
  { id: 'cli', title: 'CLI', group: 'tools', scope: 'workspace', order: 40, component: CliSettingsPage },
  { id: 'github', title: 'GitHub', group: 'tools', scope: 'workspace', order: 50, component: GitHubPage },
  { id: 'shortcuts', title: 'Shortcuts', group: 'tools', scope: 'client', order: 90, component: ShortcutsPage },
  { id: 't3-code', title: 'T3 Code', group: 'agents', scope: 'workspace', order: 10, component: AgentsPage },
  { id: 'hooks', title: 'Hooks', group: 'agents', scope: 'workspace', order: 20, component: HooksPage },
  { id: 'skills', title: 'Skills', group: 'agents', scope: 'workspace', order: 30, component: SkillsPage },
]

export function registerDefaultSettingsPages(): () => void {
  const offs = DEFAULT_SETTINGS_PAGES.map(registerSettingsPage)
  return () => { for (const off of offs) off() }
}
