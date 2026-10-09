export {
  createDocumentStore,
  type DocumentStore,
  type DocumentLink,
  type DocumentRemote,
  type ProposeOptions,
  type ProposeResult,
  type RefusedOp,
  type UndoState,
} from './store'
export {
  createClientStateStore,
  type CanvasSelection,
  type ClientState,
  type ClientStateStore,
  type Intent,
  type Viewport,
} from './clientState'
export { reportPresence, setClientAttentive, watchOtherClients, type PresenceLink } from './presence'
export {
  attachDocument,
  attachDocuments,
  documentStoreFor,
  documentWorkspaceIds,
  clientStateFor,
  otherClientsOf,
  subscribeDocumentStores,
  documentStoresVersion,
} from './registry'
