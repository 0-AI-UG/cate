// React bindings of the canvas settings, for the desktop UI.

import { useCallback, useSyncExternalStore } from 'react'
import type { WorkspaceSettingKey, WorkspaceSettings } from '@panels/settings'
import type { ClientSettingKey, ClientSettings } from '../../../../settings'
import { canvasSetting, subscribeCanvasSettings, workspaceSetting, workspaceSettingsSource } from './settings'

export function useCanvasSetting<K extends ClientSettingKey>(key: K): ClientSettings[K] {
  return useSyncExternalStore(subscribeCanvasSettings, () => canvasSetting(key))
}

export function useWorkspaceSetting<K extends WorkspaceSettingKey>(workspaceId: string, key: K): WorkspaceSettings[K] {
  const subscribe = useCallback((listener: () => void) => {
    let stopValues: () => void = () => {}
    const bind = () => {
      stopValues()
      const source = workspaceSettingsSource(workspaceId)
      stopValues = source ? source.subscribe(listener) : () => {}
    }
    bind()
    // A new install may bring a different mirror.
    const stopInstall = subscribeCanvasSettings(() => { bind(); listener() })
    return () => { stopInstall(); stopValues() }
  }, [workspaceId])
  return useSyncExternalStore(subscribe, () => workspaceSetting(workspaceId, key))
}
