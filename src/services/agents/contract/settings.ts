import { defineSettings, everyValue, setting } from '@kernel/settings/contract/define'
import type { AgentHookMode } from './hookModes'
import type { AgentId } from './registry'

export const agentSettings = defineSettings({
  scope: 'workspace',
  keys: {
    /** Per-agent override of repo-local hook injection. A missing agent is
     *  'auto': inject only when its config folder already exists. */
    agentHookInjection: setting<Partial<Record<AgentId, AgentHookMode>>>(
      {},
      everyValue((mode) => mode === 'auto' || mode === 'on' || mode === 'off'),
    ),
  },
})
