// workspace/relations ui: the relation handle, meaning selector and context
// toggle. Relation drawing is in ui/client/layout/canvas.

export { PanelRelationHandle } from './PanelRelationHandle'
export { PanelRelationSelector } from './PanelRelationSelector'
export { PanelRelationContextToggle } from './PanelRelationContextToggle'
export { connectPanelToExisting } from './connectPanel'
export {
  addRelation,
  updateRelationMeaning,
  moveRelation,
  removeRelation,
  setRelationContextMode,
} from './actions'
export { useRelationUi } from './state'
export {
  installRelationUiPort,
  relationUiPort,
  type RelationUiPort,
  type RelationMenuItem,
  type RelationContextTransport,
} from './port'
export {
  beginPanelInteraction,
  clearPanelInteractions,
  usePanelInteractionStore,
  type PanelInteraction,
  type PanelInteractionKind,
  type PanelInteractionPhase,
} from './interactions'
export {
  installRelationUiHost,
  relationRoleOf,
  relationUiHost,
  RelationCanvasProvider,
  useRelationCanvas,
  useRelationsEnabled,
  type RelationUiHost,
  type RelationDocument,
  type RelationPanelKind,
  type RelationCanvas,
  type RelationCanvasValue,
} from './host'
