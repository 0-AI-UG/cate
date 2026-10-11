// The settings pages ui/app registers at start: its own slices, the pages
// of the modules below it (kernel/api, runtime/daemon, workspace/repository,
// workspace/skills, services/agents) and the pages it hosts for slice owners
// without a page of their own yet (kernel/interaction, ui/client/layout,
// services/terminal, services/browser, panels/editor). The desktop shell
// registers General and Updates itself.

import { CliSettingsPage } from '../../kernel/api'
import { workspaceSettingsFor } from '../../kernel/settings'
import { RuntimeSettingsPage } from '../../runtime/daemon'
import { GitHubSettings, WorktreeSettings } from '../../workspace/repository'
import { SkillsSettings } from '../../workspace/skills'
import { AgentHooksSettings } from '../../services/agents'
import { documentStoreFor } from '@client/document'
import { useUIStore } from '../state/uiStore'
import { tryClientApp } from '../app'
import { DevicesPage } from '../pairing/DevicesPage'
import { MachinesPage } from '../remote/MachinesPage'
import { ConnectionNotice } from '../sidebar/connectionStatus'
import { AppearancePage } from './pages/AppearancePage'
import { CanvasPage, WorkspaceCanvasPage } from './pages/CanvasPage'
import { ShortcutsPage } from './pages/ShortcutsPage'
import { BrowserPage, EditorPage, NotificationsPage, SidebarPage, TerminalPage, WorkspaceBrowserPage, WorkspaceTerminalPage } from './pages/clientPages'
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

function HooksPage({ workspaceId }: SettingsPageProps): JSX.Element {
  return <AgentHooksSettings workspaceId={workspaceId} />
}

export const DEFAULT_SETTINGS_PAGES: readonly SettingsPage[] = [
  // This device. General (0) and Updates (90) come from the desktop shell.
  { id: 'appearance', title: 'Appearance', scope: 'client', group: 'general', order: 10, component: AppearancePage },
  { id: 'notifications', title: 'Notifications', scope: 'client', group: 'general', order: 20, component: NotificationsPage },
  { id: 'sidebar', title: 'Sidebar', scope: 'client', group: 'layout', order: 10, component: SidebarPage },
  { id: 'canvas', title: 'Canvas', scope: 'client', group: 'layout', order: 20, component: CanvasPage },
  { id: 'terminal', title: 'Terminal', scope: 'client', group: 'tools', order: 10, component: TerminalPage },
  { id: 'editor', title: 'Editor', scope: 'client', group: 'tools', order: 20, component: EditorPage },
  { id: 'browser', title: 'Browser', scope: 'client', group: 'tools', order: 30, component: BrowserPage },
  { id: 'shortcuts', title: 'Shortcuts', scope: 'client', group: 'tools', order: 40, component: ShortcutsPage },
  { id: 'machines', title: 'Machines', scope: 'client', group: 'connections', order: 10, component: MachinesPage },
  // The active workspace.
  { id: 'runtime', title: 'Runtime', scope: 'workspace', group: 'runtime', order: 10, component: RuntimePage },
  { id: 'devices', title: 'Devices', scope: 'workspace', group: 'runtime', order: 20, component: DevicesPage },
  { id: 'workspace-terminal', title: 'Terminal', scope: 'workspace', group: 'tools', order: 10, component: WorkspaceTerminalPage },
  { id: 'workspace-browser', title: 'Browser', scope: 'workspace', group: 'tools', order: 20, component: WorkspaceBrowserPage },
  { id: 'workspace-canvas', title: 'Canvas', scope: 'workspace', group: 'tools', order: 30, component: WorkspaceCanvasPage },
  { id: 'worktrees', title: 'Worktrees', scope: 'workspace', group: 'sourceControl', order: 10, component: WorktreesPage },
  { id: 'github', title: 'GitHub', scope: 'workspace', group: 'sourceControl', order: 20, component: GitHubPage },
  { id: 'cli', title: 'CLI', scope: 'workspace', group: 'agents', order: 10, component: CliSettingsPage },
  { id: 'hooks', title: 'Hooks', scope: 'workspace', group: 'agents', order: 20, component: HooksPage },
  { id: 'skills', title: 'Skills', scope: 'workspace', group: 'agents', order: 30, component: SkillsPage },
]

export function registerDefaultSettingsPages(): () => void {
  const offs = DEFAULT_SETTINGS_PAGES.map(registerSettingsPage)
  return () => { for (const off of offs) off() }
}
