import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { t3Capability } from '../contract'
import type { T3Runtime } from './t3Runtime'

export function t3CapabilityImpl(t3: T3Runtime): CapabilityImpl<typeof t3Capability> {
  return {
    panelUrl: (params) => t3.panelUrl(params),
    status: (params) => t3.status(params),
    restart: (params) => t3.restart(params),
    publishProviderProfile: (params) => t3.publishProviderProfile(params),
    providerAuthStart: (params) => t3.providerAuthStart(params),
    providerAuthGet: ({ id }) => t3.providerAuthGet(id),
    providerAuthWrite: ({ id, data }) => t3.providerAuthWrite(id, data),
    providerAuthCancel: ({ id }) => t3.providerAuthCancel(id),
    providerStatuses: () => t3.providerStatuses(),
    providerSettings: (params) => t3.providerSettings(params),
    providerModels: () => t3.providerModels(),
    conversations: (params) => t3.conversations(params),
    readConversation: (params) => t3.readConversation(params),
    renameConversation: (params) => t3.renameConversation(params),
    deleteConversation: (params) => t3.deleteConversation(params),
    startTurn: (params) => t3.startTurn(params),
    startThread: (params) => t3.startThread(params),
    threadActivity: (params) => t3.threadActivity(params),
    threadShells: (_params, sink) => t3.watchThreadShells((event) => sink.emit(event)),
  }
}
