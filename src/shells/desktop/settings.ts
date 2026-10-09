// The desktop's client settings: the shared slices plus the desktop's own
// (canvas, sidebar, notifications, remote machines, the window).

import { composeSettings, type ComposedSettings, type SettingsTable } from '@kernel/settings/contract'
import { SHARED_SETTINGS_SLICES } from '@panels/settings'
import {
  canvasSettings,
  desktopSettings,
  notificationSettings,
  remoteMachineSettings,
  sidebarSettings,
} from './contract/settings'

const DESKTOP_SETTINGS_SLICES = [
  ...SHARED_SETTINGS_SLICES,
  canvasSettings,
  sidebarSettings,
  notificationSettings,
  remoteMachineSettings,
  desktopSettings,
] as const

/** Settings of this desktop device, in every workspace. */
export type ClientSettings = ComposedSettings<(typeof DESKTOP_SETTINGS_SLICES)[number], 'client'>
export type ClientSettingKey = keyof ClientSettings & string

export const clientSettingsTable: SettingsTable<ClientSettings> = composeSettings<ClientSettings>('client', DESKTOP_SETTINGS_SLICES)
