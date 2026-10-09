// Typed proxies built from capability declarations. One generic
// implementation; there are no per-capability client classes.

import type {
  AnyCapability,
  CallOptions,
  CapabilityProxy,
  MethodSpecs,
  RuntimeProxy,
  SubscribeOptions,
} from '../contract'
import type { RpcClient } from './client'

export function createCapabilityProxy<C extends AnyCapability>(client: RpcClient, cap: C): CapabilityProxy<C> {
  const proxy: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(cap.methods as MethodSpecs)) {
    const callSpec = { mutates: spec.mutates, timeoutMs: spec.timeoutMs, crossMajor: spec.crossMajor }
    proxy[name] = (params?: unknown, opts?: CallOptions) => client.call(cap.name, name, params, callSpec, opts)
  }
  for (const name of Object.keys(cap.streams)) {
    proxy[name] = (params?: unknown, opts?: SubscribeOptions) => client.subscribe(cap.name, name, params, opts)
  }
  return Object.freeze(proxy) as CapabilityProxy<C>
}

/** The proxy of one runtime over every capability the client knows. Pass the
 *  declarations that `CapabilityRegistry` names; a missing one is undefined. */
export function createRuntimeProxy(client: RpcClient, caps: readonly AnyCapability[]): RuntimeProxy {
  const proxy: Record<string, unknown> = {}
  for (const cap of caps) {
    if (cap.name in proxy) throw new Error(`Capability "${cap.name}" given twice`)
    proxy[cap.name] = createCapabilityProxy(client, cap)
  }
  return Object.freeze(proxy) as RuntimeProxy
}
