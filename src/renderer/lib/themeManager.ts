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
