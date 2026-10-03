import { defineSettings, setting } from '@kernel/settings/contract/define'

// The master switch plus the permission matrix (surface x read/control); the
// method to cell mapping lives with the API specs.
export const cateApiSettings = defineSettings({
  scope: 'workspace',
  keys: {
    cliEnabled: setting(true),
    cliSkillInstallEnabled: setting(true),
    cliBrowserReadEnabled: setting(true),
    cliBrowserControlEnabled: setting(true),
    cliTerminalReadEnabled: setting(true),
    /** Sending keystrokes to a live shell is a separate opt-in. */
    cliTerminalInputEnabled: setting(false),
    cliPanelReadEnabled: setting(true),
    cliPanelControlEnabled: setting(true),
    cliEditorReadEnabled: setting(true),
    cliEditorControlEnabled: setting(true),
    cliNotifyEnabled: setting(true),
    cliAgentReadEnabled: setting(true),
    cliAgentControlEnabled: setting(true),
  },
})
