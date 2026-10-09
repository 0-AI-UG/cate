export {
  WorkspaceList,
  WORKSPACES_DOCUMENT,
  localRootOf,
  localWorkspaceId,
  machineWorkspaceId,
  pairedWorkspaceId,
  targetOf,
  workspaceLocation,
  type WorkspaceEntry,
  type LocalWorkspace,
  type MachineWorkspace,
  type PairedWorkspace,
  type WorkspaceListOptions,
  type WorkspaceListSnapshot,
} from './workspaceList'
export { joinWorkspace, joinErrorMessage, parsePairingInput, type JoinDeps, type PairingTarget } from './join'
export { nameJoinedWorkspaces, placeholderName } from './naming'
export { createTrustStore, openTrusted, trustStore, type TrustApi, type TrustPrompt, type TrustStore } from './trust'
