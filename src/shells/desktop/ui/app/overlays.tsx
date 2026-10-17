// Application overlays: full-content views over the workspace (settings,
// skills, pull requests, usage). ui/app renders settings; modules register
// their own views here, and `openOverlay({ view })` shows one.
//
// `ClientOverlays` is what a window mounts once: the overlay on screen, the
// command palette, the dialogs that open, join and share workspaces (and
// ssh's sign-in prompts), the trust question, the welcome notice, the tour
// and the update dialogs.

import { useSyncExternalStore, type ComponentType } from 'react'
import { WorkspaceTrustDialog } from './workspace/opening'
import { CommandPalette } from './palette/CommandPalette'
import { JoinWorkspaceDialog } from './pairing/JoinWorkspaceDialog'
import { ShareDialog } from './pairing/ShareDialog'
import { MachineFolderHost } from './remote/MachineFolderHost'
import { MachinePromptDialog } from './remote/MachinePromptDialog'
import { OpenWorkspaceDialog } from './remote/OpenWorkspaceDialog'
import { SettingsWindow } from './settings/SettingsWindow'
import { WelcomeDialog } from './dialogs/WelcomeDialog'
import { UpdateReadyDialog } from './dialogs/UpdateReadyDialog'
import { PostUpdateFeedbackDialog } from './dialogs/PostUpdateFeedbackDialog'
import { OnboardingTour } from './onboarding/OnboardingTour'
import { NotificationToasts } from './notifications'
import { useUIStore } from './state/uiStore'
import { useShownWorkspaceId } from './state/windowContent'

export interface OverlayViewProps {
  workspaceId: string | null
  section?: string
  onClose: () => void
}

const views = new Map<string, ComponentType<OverlayViewProps>>([['settings', SettingsWindow]])
const listeners = new Set<() => void>()
let version = 0

export function registerOverlay(view: string, component: ComponentType<OverlayViewProps>): () => void {
  views.set(view, component)
  version++
  for (const l of [...listeners]) l()
  return () => {
    if (views.get(view) !== component) return
    views.delete(view)
    version++
    for (const l of [...listeners]) l()
  }
}

export function hasOverlay(view: string): boolean {
  return views.has(view)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useOverlaysVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** The overlay on screen, if any. */
export function OverlayHost(): JSX.Element | null {
  useOverlaysVersion()
  const overlay = useUIStore((s) => s.overlay)
  const workspaceId = useShownWorkspaceId()
  const View = overlay ? views.get(overlay.view) : undefined
  if (!overlay || !View) return null
  return <View workspaceId={workspaceId} section={overlay.section} onClose={() => useUIStore.getState().closeOverlay()} />
}

export interface ClientOverlaysProps {
  /** First-run notices and the tour; only the main window shows them. */
  firstRun?: boolean
}

export function ClientOverlays({ firstRun = true }: ClientOverlaysProps): JSX.Element {
  return (
    <>
      <OverlayHost />
      <CommandPalette />
      <OpenWorkspaceDialog />
      <JoinWorkspaceDialog />
      <MachineFolderHost />
      <ShareDialog />
      <MachinePromptDialog />
      <WorkspaceTrustDialog />
      {firstRun && (
        <>
          <WelcomeDialog />
          <OnboardingTour />
          <PostUpdateFeedbackDialog />
        </>
      )}
      <UpdateReadyDialog />
      <NotificationToasts />
    </>
  )
}
