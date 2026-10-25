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

/** What happens when the person closes Cate, as clients offer
 *  `keepRunningWhile`: finish what's running (agents, and commands unless
 *  left out), always stay available, or stop with Cate. Every choice keeps
 *  `clients`: a device in use keeps the machine from sleeping under it. Any
 *  other list is custom. */
export type CloseChoice = 'finish' | 'always' | 'stop'

export function closeChoiceTriggers(choice: CloseChoice, commands = true): KeepRunningTrigger[] {
  switch (choice) {
    case 'finish': return commands ? ['agents', 'commands', 'clients'] : ['agents', 'clients']
    case 'always': return ['always']
    case 'stop': return ['clients']
  }
}

/** The choice `triggers` is, regardless of order, or 'custom'. */
export function closeChoiceOf(triggers: readonly KeepRunningTrigger[]): CloseChoice | 'custom' {
  if (triggers.includes('always')) return 'always'
  const is = (set: readonly KeepRunningTrigger[]) => set.length === triggers.length && set.every((t) => triggers.includes(t))
  if (is(closeChoiceTriggers('finish')) || is(closeChoiceTriggers('finish', false))) return 'finish'
  if (is(closeChoiceTriggers('stop'))) return 'stop'
  return 'custom'
}
