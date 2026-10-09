// workspace/relations contract: the typed relation graph between panels,
// relation context compilation and the relation settings. Pure; imports only
// the document.

export * from './contract/graph'
export * from './contract/settings'
export * from './contract/contextMode'
export {
  RELATION_KINDS,
  RELATION_SIDES,
  type RelationId,
  type RelationKind,
  type RelationPatch,
  type RelationSide,
} from '@workspace/document/contract'
