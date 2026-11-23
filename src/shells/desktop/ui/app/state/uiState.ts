// Cosmetic and lifecycle UI state of this device, in the DeviceStore's
// `ui-state` document (ui-state.json): kept out of settings.json so the
// settings file stays about preferences.

import { useSyncExternalStore } from 'react'
import type { DeviceStore } from '@kernel/state/contract'

export const UI_STATE_DOCUMENT = 'ui-state'

/** Bumped when the welcome/privacy notice changes, so everyone sees it again. */
export const TELEMETRY_NOTICE_VERSION = 2

export type ScreenCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
const CORNERS: readonly ScreenCorner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left']

export type UsageMetric = 'cost' | 'tokens' | 'limits'
const USAGE_METRICS: readonly UsageMetric[] = ['cost', 'tokens', 'limits']
export type UsageWindowDays = 1 | 7 | 30 | 90
const USAGE_WINDOW_DAYS: readonly UsageWindowDays[] = [1, 7, 30, 90]

export interface UiStateValues {
  /** Corner the canvas minimap button sits in. */
  minimapButtonCorner: ScreenCorner
  /** Highest welcome/privacy notice version the person dismissed. */
  telemetryNoticeAcknowledgedVersion: number
  /** The first-run tour was finished or skipped. */
  onboardingCompleted: boolean
  /** Collapsed rows of the sidebar workspace tree (keys from treeCollapse). */
  sidebarTreeCollapsed: string[]
  /** The version whose "What's New" was shown ('' before the first). */
  whatsNewSeenVersion: string
  /** What the usage overview shows, and over how many days. */
  usageMetric: UsageMetric
  usageWindowDays: UsageWindowDays
}

export const DEFAULT_UI_STATE: UiStateValues = {
  minimapButtonCorner: 'bottom-right',
  telemetryNoticeAcknowledgedVersion: 0,
  onboardingCompleted: false,
  sidebarTreeCollapsed: [],
  whatsNewSeenVersion: '',
  usageMetric: 'cost',
  usageWindowDays: 30,
}

export function normalizeUiState(raw: unknown): UiStateValues {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const version = o.telemetryNoticeAcknowledgedVersion
  return {
    minimapButtonCorner: CORNERS.includes(o.minimapButtonCorner as ScreenCorner)
      ? (o.minimapButtonCorner as ScreenCorner)
      : DEFAULT_UI_STATE.minimapButtonCorner,
    telemetryNoticeAcknowledgedVersion: typeof version === 'number' && Number.isInteger(version) && version >= 0
      ? version
      : DEFAULT_UI_STATE.telemetryNoticeAcknowledgedVersion,
    onboardingCompleted: typeof o.onboardingCompleted === 'boolean' ? o.onboardingCompleted : DEFAULT_UI_STATE.onboardingCompleted,
    sidebarTreeCollapsed: Array.isArray(o.sidebarTreeCollapsed)
      ? o.sidebarTreeCollapsed.filter((k): k is string => typeof k === 'string')
      : DEFAULT_UI_STATE.sidebarTreeCollapsed,
    whatsNewSeenVersion: typeof o.whatsNewSeenVersion === 'string' ? o.whatsNewSeenVersion : DEFAULT_UI_STATE.whatsNewSeenVersion,
    usageMetric: USAGE_METRICS.includes(o.usageMetric as UsageMetric) ? (o.usageMetric as UsageMetric) : DEFAULT_UI_STATE.usageMetric,
    usageWindowDays: USAGE_WINDOW_DAYS.includes(o.usageWindowDays as UsageWindowDays)
      ? (o.usageWindowDays as UsageWindowDays)
      : DEFAULT_UI_STATE.usageWindowDays,
  }
}

export interface UiStateSnapshot extends UiStateValues {
  /** False until the device document was read. */
  loaded: boolean
}

export interface UiStateStore {
  load(): Promise<void>
  getSnapshot(): UiStateSnapshot
  set<K extends keyof UiStateValues>(key: K, value: UiStateValues[K]): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function createUiStateStore(device: DeviceStore): UiStateStore {
  let snapshot: UiStateSnapshot = { ...DEFAULT_UI_STATE, loaded: false }
  const listeners = new Set<() => void>()
  const notify = () => { for (const l of [...listeners]) l() }
  const apply = (raw: unknown) => {
    snapshot = { ...normalizeUiState(raw), loaded: true }
    notify()
  }
  const unsubscribe = device.subscribe(UI_STATE_DOCUMENT, apply)
  return {
    async load() {
      try {
        apply(await device.get(UI_STATE_DOCUMENT))
      } catch {
        apply(undefined)
      }
    },
    getSnapshot: () => snapshot,
    set(key, value) {
      snapshot = { ...snapshot, [key]: value }
      notify()
      const { loaded: _loaded, ...values } = snapshot
      void device.set(UI_STATE_DOCUMENT, values).catch(() => {})
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      listeners.clear()
      unsubscribe()
    },
  }
}

// --- The installed store ---------------------------------------------------

const UNLOADED: UiStateSnapshot = { ...DEFAULT_UI_STATE, loaded: false }
let installed: UiStateStore | null = null
const installListeners = new Set<() => void>()

export function installUiState(store: UiStateStore | null): void {
  installed = store
  for (const l of [...installListeners]) l()
}

export function uiState(): UiStateStore | null {
  return installed
}

/** Calls `listener` on every change of the installed store, and when a store
 *  is installed or replaced. */
export function subscribeUiState(listener: () => void): () => void {
  let off = installed?.subscribe(listener) ?? (() => {})
  const onInstall = () => {
    off()
    off = installed?.subscribe(listener) ?? (() => {})
    listener()
  }
  installListeners.add(onInstall)
  return () => {
    installListeners.delete(onInstall)
    off()
  }
}

export function useUiState(): UiStateSnapshot {
  return useSyncExternalStore(subscribeUiState, () => installed?.getSnapshot() ?? UNLOADED)
}

export function setUiState<K extends keyof UiStateValues>(key: K, value: UiStateValues[K]): void {
  installed?.set(key, value)
}
