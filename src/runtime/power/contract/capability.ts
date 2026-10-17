// The `power` host capability (architecture 7.9): keep the runtime's machine
// awake. A person can ask for it for a while or until turned off; the runtime
// also holds it on its own while work runs.

import { channelStream, defineCapability, method } from '@kernel/rpc/contract'

export const KEEP_AWAKE_DURATIONS = [30, 60, 300] as const

/** Minutes, `null` for until turned off, `false` to turn the request off. */
export type KeepAwakeDuration = (typeof KEEP_AWAKE_DURATIONS)[number] | null | false

export function isKeepAwakeDuration(value: unknown): value is KeepAwakeDuration {
  return value === null || value === false || (KEEP_AWAKE_DURATIONS as readonly unknown[]).includes(value)
}

export interface PowerState {
  /** Someone asked to keep the machine awake. */
  requested: boolean
  /** Unix ms when the request lapses; null while unlimited or off. */
  endsAt: number | null
  /** Work is running, so the runtime holds the machine awake on its own. */
  busy: boolean
  /** The platform helper is holding the machine awake right now. */
  holding: boolean
}

export const powerCapability = defineCapability('power', {
  methods: {
    get: method<void, PowerState>(),
    set: method<{ duration: KeepAwakeDuration }, PowerState>({ mutates: true }),
  },
  streams: {
    subscribe: channelStream<void, PowerState>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    power: typeof powerCapability
  }
}
