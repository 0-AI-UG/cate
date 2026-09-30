// The editor font client settings, as the view reads them. The shell installs
// its client settings store (`ClientSettingsStore` satisfies the source);
// without one the view uses the slice defaults.

import { useSyncExternalStore } from 'react'
import { editorSettings } from '../contract'

type FontKey = 'editorFontSize' | 'editorFontFamily'

export interface EditorSettingsSource {
  get(key: 'editorFontSize'): number
  get(key: 'editorFontFamily'): string
  subscribe(cb: (values: unknown, patch: Partial<Record<FontKey, unknown>>) => void): () => void
}

export interface EditorFont {
  fontSize: number
  fontFamily: string
}

const DEFAULT_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'

let source: EditorSettingsSource | null = null
const listeners = new Set<() => void>()
let unsubscribeSource: (() => void) | null = null
let cached: EditorFont | null = null

const notify = () => {
  cached = null
  for (const listener of [...listeners]) listener()
}

export function installEditorSettings(next: EditorSettingsSource | null): void {
  unsubscribeSource?.()
  source = next
  unsubscribeSource = next?.subscribe((_values, patch) => {
    if ('editorFontSize' in patch || 'editorFontFamily' in patch) notify()
  }) ?? null
  notify()
}

function editorFont(): EditorFont {
  if (cached) return cached
  const keys = editorSettings.keys
  const fontSize = source ? source.get('editorFontSize') : keys.editorFontSize.default
  const fontFamily = (source ? source.get('editorFontFamily') : keys.editorFontFamily.default) || DEFAULT_FONT_FAMILY
  cached = { fontSize, fontFamily }
  return cached
}

export function useEditorFont(): EditorFont {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    editorFont,
  )
}
