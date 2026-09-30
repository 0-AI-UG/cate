// workspace/relations contract: the typed relation graph between panels,
// relation context compilation and the relation settings. Pure.

export * from './contract/graph'
export * from './contract/settings'
export * from './contract/drafts'
export {
  RELATION_KINDS,
  RELATION_SIDES,
  type RelationId,
  type RelationKind,
  type RelationPatch,
  type RelationSide,
} from '@workspace/document/contract'
export * from './contract/geometry'
