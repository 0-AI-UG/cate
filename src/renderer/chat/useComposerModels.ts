// =============================================================================
// useComposerModels — the provider-grouped model list every chat composer shows.
//
// One source for the model pill's options: fetch the list on mount, and expose a
// refresh so a surface can re-pull when its model menu opens (a provider signed
// in since mount then shows up). The fetch swallows errors — a transient
// provider-list failure just leaves the last known set in place.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import type { ModelOption } from './ChatComposer'

export interface ComposerModels {
  models: ModelOption[]
  refreshModels: () => void
}

export function useComposerModels(): ComposerModels {
  const [models, setModels] = useState<ModelOption[]>([])
  const refreshModels = useCallback(() => {
    window.electronAPI
      .agentListModels()
      .then((list) => setModels(list.map((m) => ({ provider: m.provider, model: m.id, label: m.label }))))
      .catch(() => {})
  }, [])
  useEffect(() => {
    refreshModels()
  }, [refreshModels])
  return { models, refreshModels }
}
