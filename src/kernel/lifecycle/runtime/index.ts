// The daemon's lifecycle bus. The rpc server emits client presence on it; the
// daemon entry emits shutdown.

import { createLifecycleBus, type LifecycleBus } from '../contract'

export type { ClientConnection, LifecycleBus } from '../contract'

export const lifecycle: LifecycleBus = createLifecycleBus()

export const onShutdown: LifecycleBus['onShutdown'] = (listener) => lifecycle.onShutdown(listener)
export const onClientConnected: LifecycleBus['onClientConnected'] = (listener) => lifecycle.onClientConnected(listener)
export const onClientGone: LifecycleBus['onClientGone'] = (listener) => lifecycle.onClientGone(listener)
export const emitShutdown: LifecycleBus['emitShutdown'] = (reason) => lifecycle.emitShutdown(reason)
export const emitClientConnected: LifecycleBus['emitClientConnected'] = (client) => lifecycle.emitClientConnected(client)
export const emitClientGone: LifecycleBus['emitClientGone'] = (client) => lifecycle.emitClientGone(client)
