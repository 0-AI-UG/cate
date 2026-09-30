import { useSyncExternalStore } from 'react'
import { documentStoresVersion, subscribeDocumentStores } from '@client/document'
import { presentationsFor, type DockPresentation } from './presentation'

/** The workspace's dock presentations, re-rendering when they change. */
export function usePresentations(workspaceId: string): readonly DockPresentation[] {
  // A presentation store follows its document once the document is open.
  useSyncExternalStore(subscribeDocumentStores, documentStoresVersion)
  const store = presentationsFor(workspaceId)
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
