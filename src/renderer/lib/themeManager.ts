import type { AppearanceMode } from '../../shared/types'

export type ResolvedTheme = 'dark-warm' | 'light-subtle' | 'dark-cold'

let currentResolved: ResolvedTheme = 'dark-warm'
let currentMode: AppearanceMode = 'system'
const subscribers = new Set<(t: ResolvedTheme) => void>()

let mediaQuery: MediaQueryList | null = null
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

function resolveSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark-warm'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark-warm' : 'light-subtle'
}

function notify(theme: ResolvedTheme) {
  for (const cb of subscribers) {
    cb(theme)
  }
}

function attachMediaListener() {
  if (typeof window === 'undefined') return
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  mediaListener = (e: MediaQueryListEvent) => {
    if (currentMode !== 'system') return
    const next: ResolvedTheme = e.matches ? 'dark-warm' : 'light-subtle'
    currentResolved = next
    document.documentElement.dataset.theme = next
    notify(next)
  }
  mediaQuery.addEventListener('change', mediaListener)
}

function detachMediaListener() {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener('change', mediaListener)
    mediaQuery = null
    mediaListener = null
  }
}

// Background colors per theme — kept in sync with the CSS variables in
// src/renderer/styles.css. Used to seed the BrowserWindow backgroundColor
// via the boot snapshot so cold launches have no white flash.
const THEME_BG: Record<ResolvedTheme, string> = {
  'dark-warm': '#1f1e1c',
  'dark-cold': '#1a1d22',
  'light-subtle': '#f4f3f0',
}

export function applyTheme(mode: AppearanceMode): void {
  currentMode = mode

  let resolved: ResolvedTheme
  if (mode === 'system') {
    resolved = resolveSystemTheme()
    detachMediaListener()
    attachMediaListener()
  } else {
    detachMediaListener()
    resolved = mode as ResolvedTheme
  }

  currentResolved = resolved
  document.documentElement.dataset.theme = resolved
  notify(resolved)

  // Persist resolved theme + matching background to boot snapshot so the
  // next cold launch can construct the BrowserWindow with the right color
  // before any JS runs.
  try {
    const api = (window as unknown as {
      electronAPI?: { bootSnapshotWrite?: (p: Record<string, unknown>) => Promise<void> }
    }).electronAPI
    api?.bootSnapshotWrite?.({ theme: resolved, backgroundColor: THEME_BG[resolved] }).catch(() => { /* noop */ })
  } catch { /* noop */ }
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved
}

export function subscribeTheme(cb: (t: ResolvedTheme) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}
