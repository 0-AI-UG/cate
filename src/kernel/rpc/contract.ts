// kernel/rpc contract: the runtime protocol (architecture 6, 7.8). Pure.

import type { AnyCapability, CapabilityProxy } from './contract/capability'

export * from './contract/messages'
export * from './contract/errors'
export * from './contract/features'
export * from './contract/capability'
export * from './contract/channel'
export * from './contract/framing'
export * from './contract/port'

/**
 * Every capability a runtime can serve, keyed by name. Each module adds its
 * declaration next to it:
 *
 *   declare module '@kernel/rpc/contract' {
 *     interface CapabilityRegistry { file: typeof fileCapability }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CapabilityRegistry {}

/** The typed proxy of one workspace runtime: `runtime.file.read({ path })`. */
export type RuntimeProxy = {
  readonly [K in keyof CapabilityRegistry]: CapabilityRegistry[K] extends AnyCapability
    ? CapabilityProxy<CapabilityRegistry[K]>
    : never
}
