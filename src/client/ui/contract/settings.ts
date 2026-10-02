import { defineSettings, everyItem, numberIn, setting } from '@kernel/settings/contract/define'
import { isSshMachine, type SshMachine } from '@runtime/daemon/contract/ssh'

export const sidebarSettings = defineSettings({
  scope: 'client',
  keys: {
    sidebarTintOpacity: setting(1.0, numberIn(0.3, 1)),
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

/** Machines this device sets workspaces up on over SSH ("Remote machines"). */
export const remoteMachineSettings = defineSettings({
  scope: 'client',
  keys: {
    sshMachines: setting<SshMachine[]>([], everyItem(isSshMachine)),
  },
})
