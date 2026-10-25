import { defineSettings, everyItem, oneOf, setting } from '@kernel/settings/contract/define'

/** What keeps the workspace available (architecture 7.4): each picked
 *  trigger keeps the runtime running and its machine awake while it holds. */
export const KEEP_RUNNING_TRIGGERS = ['agents', 'commands', 'clients', 'always'] as const
export type KeepRunningTrigger = (typeof KEEP_RUNNING_TRIGGERS)[number]
export type RuntimeNetwork = 'off' | 'sameNetwork' | 'cateConnect'

export const runtimeSettings = defineSettings({
  scope: 'workspace',
  keys: {
    keepRunningWhile: setting<KeepRunningTrigger[]>(['agents', 'commands', 'clients'], everyItem((item) => (KEEP_RUNNING_TRIGGERS as readonly unknown[]).includes(item))),
    runtimeNetwork: setting<RuntimeNetwork>('off', oneOf('off', 'sameNetwork', 'cateConnect')),
  },
})
