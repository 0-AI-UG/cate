// Desktop-only actions ui/app offers when a shell provides them: the app
// updater, the post-update feedback prompt, native menus, window chrome and
// usage analytics. The desktop shell fills this slot; other shells leave it
// empty and the UI hides what depends on it.

import { useSyncExternalStore } from 'react'

export type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'downloaded' | 'error' | 'disabled'

export interface UpdateStatus {
  state: UpdateState
  version: string | null
  /** 0-100 while downloading. */
  percent?: number
  message?: string
  /** Answers an explicit check. */
  manual?: boolean
  /** Reopen the "update ready" dialog even for a dismissed version. */
  forceShow?: boolean
}

export interface FeedbackPrompt {
  /** Empty on a first install. */
  fromVersion: string
  toVersion: string
}

export interface MenuItem {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
  submenu?: MenuItem[]
}

export interface DesktopPort {
  // App updates.
  updateStatus(): Promise<UpdateStatus>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  checkForUpdates(): Promise<void>
  /** Resolves false when nothing is staged. */
  quitAndInstallUpdate(): Promise<boolean>
  // What's new and feedback after an update.
  pendingFeedback(): Promise<FeedbackPrompt | null>
  onFeedbackPrompt(listener: (prompt: FeedbackPrompt) => void): () => void
  dismissFeedback(): void
  submitFeedback(feedback: { rating: number; comment?: string }): Promise<{ buffered: boolean }>
  // Native chrome.
  /** Resolves the chosen item id, or null. */
  showContextMenu(items: MenuItem[]): Promise<string | null>
  /** Native application menu picks, as shortcut action ids. */
  onMenuAction(listener: (action: string) => void): () => void
  /** Space the window controls take at the top left, in px (0 when none). */
  windowControlsInset(): number
  onWindowControlsInsetChange(listener: () => void): () => void
  /** Brings a detached window of a workspace to the front. */
  focusWindow(workspaceId: string, windowId: string): void
  /** Shows an application overlay (settings, ...) in the main window; used
   *  from a detached window, which has no room for it. Returns false when this
   *  is the main window. */
  showOverlayInMainWindow?(request: { view: string; section?: string }): boolean
  /** Opens the device's client settings file in the OS. */
  openClientSettingsFile(): Promise<void>
  /** Asks for a folder to open as a workspace. */
  pickFolder(): Promise<string | null>
  /** Asks for an image file; returns its path. */
  pickImage(): Promise<string | null>
  // Usage analytics; never carries paths or names.
  trackEvent(name: string, props?: Record<string, string | number | boolean>): void
}

let port: DesktopPort | null = null
const listeners = new Set<() => void>()

export function installDesktopPort(next: DesktopPort | null): void {
  port = next
  for (const l of [...listeners]) l()
}

/** The desktop port, or null on a shell without one. */
export function desktopPort(): DesktopPort | null {
  return port
}

export function subscribeDesktopPort(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Fire-and-forget analytics; a no-op without a desktop port. */
export function track(name: string, props?: Record<string, string | number | boolean>): void {
  try { port?.trackEvent(name, props) } catch { /* analytics never breaks the UI */ }
}

/** The desktop port, re-rendering when a shell installs one. */
export function useDesktopPort(): DesktopPort | null {
  return useSyncExternalStore(subscribeDesktopPort, desktopPort)
}
