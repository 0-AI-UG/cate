import { defineSettings, numberIn, setting } from '@kernel/settings/contract/define'

export const sidebarSettings = defineSettings({
  scope: 'client',
  keys: {
    sidebarTintOpacity: setting(1.0, numberIn(0.3, 1)),
    showFileExplorerOnLaunch: setting(false),
    showSkillsInWorkspaceOverview: setting(true),
  },
})

export const notificationSettings = defineSettings({
  scope: 'client',
  keys: {
    notificationsEnabled: setting(true),
    notifyOnlyWhenUnfocused: setting(true),
  },
})
