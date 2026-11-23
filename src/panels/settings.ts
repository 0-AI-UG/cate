// The settings slices every client and the runtime share, composed into the
// workspace settings and the shared client settings (section 8). A new slice
// is one line here. Each shell adds its own client slices (the desktop's in
// `shells/desktop/settings.ts`); the kernel composes nothing.

import { composeSettings, type ComposedSettings, type SettingsTable } from '@kernel/settings/contract'
import { appearanceSettings, shortcutSettings } from '@kernel/interaction/contract/settings'
import { cateApiSettings } from '@kernel/api/contract/settings'
import { runtimeSettings } from '@runtime/daemon/contract/settings'
import { relationLabelSettings, relationSettings } from '@workspace/relations/contract/settings'
import { repositorySettings } from '@workspace/repository/contract/settings'
import { notificationSettings } from '@workspace/notifications/contract/settings'
import { terminalClientSettings, terminalSettings } from '@services/terminal/contract/settings'
import { browserClientSettings, browserSettings } from '@services/browser/contract/settings'
import { agentSettings } from '@services/agents/contract/settings'
import { editorSettings } from '@panels/editor/contract/settings'
import { reviewSettings } from '@panels/review/contract/settings'

export const SHARED_SETTINGS_SLICES = [
  appearanceSettings,
  shortcutSettings,
  cateApiSettings,
  runtimeSettings,
  relationLabelSettings,
  relationSettings,
  repositorySettings,
  notificationSettings,
  terminalClientSettings,
  terminalSettings,
  browserClientSettings,
  browserSettings,
  agentSettings,
  editorSettings,
  reviewSettings,
] as const

type Slice = (typeof SHARED_SETTINGS_SLICES)[number]

/** Settings of one workspace, shared by every client of it. */
export type WorkspaceSettings = ComposedSettings<Slice, 'workspace'>
export type WorkspaceSettingKey = keyof WorkspaceSettings & string
/** The client settings every shell has (a shell adds its own slices). */
export type SharedClientSettings = ComposedSettings<Slice, 'client'>

export const workspaceSettingsTable: SettingsTable<WorkspaceSettings> = composeSettings<WorkspaceSettings>('workspace', SHARED_SETTINGS_SLICES)
export const sharedClientSettingsTable: SettingsTable<SharedClientSettings> = composeSettings<SharedClientSettings>('client', SHARED_SETTINGS_SLICES)
