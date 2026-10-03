// Every slice, composed into the two settings types and their validation
// tables. A new slice is one line here.

import { composeSettings, type ComposedSettings, type SettingsTable } from './define'
import { appearanceSettings, shortcutSettings } from '@kernel/interaction/contract/settings'
import { cateApiSettings } from '@kernel/api/contract/settings'
import { runtimeSettings } from '@runtime/daemon/contract/settings'
import { relationLabelSettings, relationSettings } from '@workspace/relations/contract/settings'
import { repositorySettings } from '@workspace/repository/contract/settings'
import { terminalClientSettings, terminalSettings } from '@services/terminal/contract/settings'
import { browserClientSettings, browserSettings } from '@services/browser/contract/settings'
import { agentSettings } from '@services/agents/contract/settings'
import { editorSettings } from '@panels/editor/contract/settings'
import { reviewSettings } from '@panels/review/contract/settings'
import {
  canvasSettings,
  desktopSettings,
  notificationSettings,
  remoteMachineSettings,
  sidebarSettings,
} from '@shells/desktop/contract/settings'

export const SETTINGS_SLICES = [
  appearanceSettings,
  shortcutSettings,
  cateApiSettings,
  runtimeSettings,
  relationLabelSettings,
  relationSettings,
  repositorySettings,
  terminalClientSettings,
  terminalSettings,
  browserClientSettings,
  browserSettings,
  agentSettings,
  canvasSettings,
  sidebarSettings,
  notificationSettings,
  remoteMachineSettings,
  editorSettings,
  reviewSettings,
  desktopSettings,
] as const

type Slice = (typeof SETTINGS_SLICES)[number]

/** Settings of one client device, in every workspace. */
export type ClientSettings = ComposedSettings<Slice, 'client'>
/** Settings of one workspace, shared by every client of it. */
export type WorkspaceSettings = ComposedSettings<Slice, 'workspace'>

export type ClientSettingKey = keyof ClientSettings & string
export type WorkspaceSettingKey = keyof WorkspaceSettings & string

export const clientSettingsTable: SettingsTable<ClientSettings> = composeSettings<ClientSettings>('client', SETTINGS_SLICES)
export const workspaceSettingsTable: SettingsTable<WorkspaceSettings> = composeSettings<WorkspaceSettings>('workspace', SETTINGS_SLICES)
