import { defineSettings, oneOf, setting } from '@kernel/settings/contract/define'

export type RuntimeLifetime = 'stopWhenIdle' | 'keepRunning'
export type RuntimeNetwork = 'off' | 'sameNetwork' | 'cateConnect'

export const runtimeSettings = defineSettings({
  scope: 'workspace',
  keys: {
    runtimeLifetime: setting<RuntimeLifetime>('stopWhenIdle', oneOf('stopWhenIdle', 'keepRunning')),
    runtimeNetwork: setting<RuntimeNetwork>('off', oneOf('off', 'sameNetwork', 'cateConnect')),
  },
})
