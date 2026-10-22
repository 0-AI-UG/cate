// The personal library of relation labels (the client setting
// `savedPanelRelationLabels`), edited the same way on every client.

import { RELATION_LABEL_MAX } from '../contract'
import { updateRelationMeaning, type RelationDocument } from './edits'

/** Where a client keeps the library: its client settings. */
export interface RelationLabelLibrary {
  get(): string[]
  set(labels: string[]): void
}

const clean = (label: string): string => label.trim().slice(0, RELATION_LABEL_MAX)
const same = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase()

/** Gives a relation words of its own in place of its kind's, the kind kept.
 *  Returns false for empty words, a gone relation or a failed op. */
export function labelRelation(store: RelationDocument, relationId: string, label: string): boolean {
  const words = clean(label)
  const relation = store.getSnapshot().relations[relationId]
  return !!words && !!relation && updateRelationMeaning(store, relationId, relation.kind, words)
}

/** Puts a label first in the library, once whatever its case. */
export function rememberRelationLabel(library: RelationLabelLibrary, label: string): void {
  const words = clean(label)
  if (words) library.set([words, ...library.get().filter((saved) => !same(saved, words))])
}

/** Renames a saved label in place; relations keep the words they have. */
export function renameRelationLabel(library: RelationLabelLibrary, label: string, to: string): void {
  const words = clean(to)
  if (!words) return
  const renamed = library.get().map((saved) => saved === label ? words : saved)
  library.set(renamed.filter((saved, index) => renamed.findIndex((other) => same(other, saved)) === index))
}

/** Removes a saved label; relations keep the words they have. */
export function forgetRelationLabel(library: RelationLabelLibrary, label: string): void {
  library.set(library.get().filter((saved) => saved !== label))
}
