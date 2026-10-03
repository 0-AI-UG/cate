// The client settings a terminal view reads. The shell installs the client's
// settings store once (`installTerminalViewSettings`); until then views use
// the defaults.

import { useSyncExternalStore } from 'react'
import { clientSettingsTable, type ClientSettings } from '@kernel/settings/contract'

export interface TerminalSettingsSource {
  getAll(): ClientSettings
  set<K extends keyof ClientSettings & string>(key: K, value: ClientSettings[K]): boolean
  subscribe(listener: () => void): () => void
}

const DEFAULT_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'
const DEFAULT_FONT_SIZE = 13

let source: TerminalSettingsSource | null = null
const installListeners = new Set<() => void>()

export function installTerminalViewSettings(next: TerminalSettingsSource | null): void {
  source = next
  for (const listener of [...installListeners]) listener()
}

export function terminalViewSettings(): ClientSettings {
  return source?.getAll() ?? clientSettingsTable.defaults
}

export function setTerminalViewSetting<K extends keyof ClientSettings & string>(key: K, value: ClientSettings[K]): void {
  source?.set(key, value)
}

export function resolveTerminalFontFamily(raw: string): string {
  return (typeof raw === 'string' ? raw.trim() : '') || DEFAULT_FONT_FAMILY
}

/** 0 follows the editor font size. */
export function resolveTerminalFontSize(raw: number, editorFontSize: number): number {
  const size = Number.isFinite(raw) && raw > 0 ? raw : editorFontSize
  return Number.isFinite(size) && size > 0 ? Math.max(1, Math.min(size, 32)) : DEFAULT_FONT_SIZE
}

/** What an xterm takes from the settings. */
export interface TerminalOptionsFromSettings {
  fontFamily: string
  fontSize: number
  scrollSensitivity: number
  minimumContrastRatio: number
  cursorBlink: boolean
  macOptionIsMeta: boolean
}

export function terminalOptions(settings: ClientSettings): TerminalOptionsFromSettings {
  return {
    fontFamily: resolveTerminalFontFamily(settings.terminalFontFamily),
    fontSize: resolveTerminalFontSize(settings.terminalFontSize, settings.editorFontSize),
    scrollSensitivity: settings.terminalScrollSpeed,
    minimumContrastRatio: settings.terminalContrast,
    cursorBlink: settings.terminalCursorBlink,
    macOptionIsMeta: settings.terminalOptionIsMeta,
  }
}

const sameOptions = (a: TerminalOptionsFromSettings, b: TerminalOptionsFromSettings) =>
  (Object.keys(a) as (keyof TerminalOptionsFromSettings)[]).every((key) => a[key] === b[key])

let cached: TerminalOptionsFromSettings = terminalOptions(terminalViewSettings())
const read = (): TerminalOptionsFromSettings => {
  const next = terminalOptions(terminalViewSettings())
  if (!sameOptions(next, cached)) cached = next
  return cached
}

const subscribe = (listener: () => void): (() => void) => {
  let off = source?.subscribe(listener) ?? (() => {})
  const onInstall = () => {
    off()
    off = source?.subscribe(listener) ?? (() => {})
    listener()
  }
  installListeners.add(onInstall)
  return () => {
    off()
    installListeners.delete(onInstall)
  }
}

export function useTerminalOptions(): TerminalOptionsFromSettings {
  return useSyncExternalStore(subscribe, read)
}
