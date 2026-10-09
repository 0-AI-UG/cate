// The `push` host capability: a paired device asks the runtime to reach it
// while it is not connected. The device names where its push service
// delivers (`target`, opaque here: only Cate Connect reads it) and gives a
// key; the runtime seals each notification event with that key and hands it
// to Cate Connect, which delivers it without being able to read it.

import { defineCapability, method } from '@kernel/rpc/contract'

/** A delivery target: `<service>:<address>`, at most 256 characters. */
export function isPushTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^[a-z0-9]+:[A-Za-z0-9:._-]+$/.test(value)
}

export interface PushStatus {
  /** The calling device is registered for pushes from this runtime. */
  registered: boolean
  /** Why pushes cannot go out right now: network access is not Cate
   *  Connect, or the service does not send pushes (not reached yet, or
   *  without an APNs key). Null when they can. */
  blocked: 'cateConnectOff' | 'serviceUnavailable' | null
}

export const pushCapability = defineCapability('push', {
  methods: {
    /** Registers the calling device: where its pushes go (`target`) and the
     *  32-byte `key` (base64) they are sealed with. Replaces an earlier
     *  registration of the device. */
    register: method<{ target: string; key: string }, PushStatus>({ mutates: true }),
    unregister: method<void, PushStatus>({ mutates: true }),
    status: method<void, PushStatus>(),
  },
  streams: {},
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    push: typeof pushCapability
  }
}
