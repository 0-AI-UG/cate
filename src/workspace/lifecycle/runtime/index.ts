import path from 'node:path'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { WorkspaceInfo, workspaceCapability } from '../contract'
import type { TrustGate } from './trust'

export { createTrustGate, type TrustGate, type TrustGateOptions } from './trust'

export function workspaceInfo(runtimeId: string, root: string): WorkspaceInfo {
  return { runtimeId, root, name: path.basename(root) || root }
}

export function workspaceCapabilityImpl(deps: { trust: TrustGate; info: WorkspaceInfo }): CapabilityImpl<typeof workspaceCapability> {
  const { trust, info } = deps
  return {
    info: () => info,
    getTrust: () => trust.state(),
    setTrust: ({ trusted }) => trust.set(trusted === true),
    watchTrust: (_params, sink) => {
      sink.emit(trust.state())
      return trust.onChange((state) => sink.emit(state))
    },
  }
}
