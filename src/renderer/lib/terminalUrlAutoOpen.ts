// =============================================================================
// terminalUrlAutoOpen
//
// Watches PTY output for printable URLs and surfaces them in a browser panel.
//
// Behavior (see "Auto-open URLs from terminal" setting):
//   - Watches each data chunk for http(s) URLs and bare localhost / loopback
//     addresses with an optional port and path.
//   - Reuses an existing browser panel in the same workspace by calling
//     loadURL on its <webview>. Only creates a new panel when none exists.
//   - Each URL is opened at most once per session (canonicalized).
// =============================================================================

import { useSettingsStore } from '../stores/settingsStore'
import { useAppStore } from '../stores/appStore'
import { useUrlPromptStore } from '../stores/urlPromptStore'
import { portalRegistry } from './portalRegistry'

// Disallowed characters inside a URL match: whitespace, ASCII control bytes,
// quote/angle-bracket characters, and the bracket families. Excluding
// brackets/parens prevents prose like "running at http://x (API on :3002)"
// from being captured as a single URL ending with "(API".
const URL_BODY = '[^\\s\\u0000-\\u001f"<>()\\[\\]{}`]'
const URL_REGEX = new RegExp(
  '\\b(?:https?:\\/\\/' + URL_BODY + '+|' +
    '(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(?::\\d{1,5})(?:\\/' + URL_BODY + '*)?)',
  'gi',
)

// Strip common terminal escape sequences before scanning so ANSI color codes
// do not break URL matching.
const ANSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?(?:\x07|\x1b\\)/g

// Per-panel rolling buffer so URLs split across PTY writes still match. ~2 KB
// is generous; URLs printed by dev servers are typically followed by a newline
// within a single chunk.
const BUFFERS = new Map<string, string>()
const MAX_BUFFER = 2048

// Session-scoped dedupe: every URL that has triggered an auto-open OR has
// been deliberately skipped (e.g. labeled as an API endpoint). Either way we
// never want to act on the same URL twice.
const OPENED = new Set<string>()
const MAX_OPENED = 500

// Labels appearing just before a URL ("API:", "Backend:", "GraphQL:") that
// indicate the URL is a machine-facing endpoint, not a UI to open in a browser.
const NON_UI_LABELS = new Set([
  'api', 'apis', 'backend', 'server', 'graphql', 'gql', 'rpc', 'grpc',
  'ws', 'wss', 'websocket', 'socket', 'db', 'database', 'postgres', 'postgresql',
  'mysql', 'redis', 'mongo', 'mongodb', 'kafka', 'metrics', 'prometheus',
  'healthcheck', 'healthz', 'readyz', 'livez', 'admin',
])

// Labels appearing just before a URL that strongly indicate a UI surface.
const UI_LABELS = new Set([
  'frontend', 'front', 'web', 'ui', 'app', 'client', 'site', 'page',
  'local', 'localhost', 'dev', 'preview', 'storybook', 'docs', 'documentation',
  'vite', 'next', 'nuxt',
])

function labelBefore(buffer: string, matchIndex: number): string | null {
  // Look back to the start of the line and grab the last word-ish token
  // immediately before the URL (allowing for a trailing colon / dash / space).
  const lineStart = buffer.lastIndexOf('\n', matchIndex - 1) + 1
  const prefix = buffer.slice(lineStart, matchIndex)
  // Match "label" optionally followed by ":" / "=" / "-" and trailing spaces.
  const m = prefix.match(/([A-Za-z][A-Za-z0-9_-]{1,24})\s*[:=-]?\s*$/)
  return m ? m[1].toLowerCase() : null
}

function classify(buffer: string, matchIndex: number): 'ui' | 'non-ui' | 'unknown' {
  const label = labelBefore(buffer, matchIndex)
  if (!label) return 'unknown'
  if (NON_UI_LABELS.has(label)) return 'non-ui'
  if (UI_LABELS.has(label)) return 'ui'
  return 'unknown'
}

function canonicalize(rawUrl: string): string {
  let url = rawUrl
  // Strip trailing punctuation commonly adjacent to URLs in prose / log output.
  url = url.replace(/[)\].,;:!?'>]+$/, '')
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url
  }
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

function findBrowserPanelId(workspaceId: string): string | null {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws) return null
  for (const panel of Object.values(ws.panels)) {
    if (panel.type === 'browser') return panel.id
  }
  return null
}

export function openTerminalUrl(workspaceId: string, url: string): void {
  openInBrowser(workspaceId, url)
}

function openInBrowser(workspaceId: string, url: string): void {
  const existing = findBrowserPanelId(workspaceId)
  if (existing) {
    const webview = portalRegistry.get(existing)
    if (webview) {
      try {
        webview.loadURL(url)
        useAppStore.getState().updatePanelUrl(workspaceId, existing, url)
        return
      } catch {
        // Fall through if the guest webContents is not dom-ready yet.
      }
    }
    // Browser panel exists but webview is not registered yet — still prefer
    // updating its URL so it picks it up on next mount.
    useAppStore.getState().updatePanelUrl(workspaceId, existing, url)
    return
  }
  useAppStore.getState().createBrowser(workspaceId, url)
}

export function scanTerminalChunkForUrls(
  panelId: string,
  workspaceId: string,
  chunk: string,
): void {
  const mode = useSettingsStore.getState().autoOpenUrlsFromTerminal
  if (mode === 'off') return
  if (!chunk) return

  const cleaned = chunk.replace(ANSI_REGEX, '')
  const prev = BUFFERS.get(panelId) ?? ''
  let buffer = prev + cleaned
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER)

  // Only act on matches whose end is not at the buffer tail — the tail may
  // still be receiving more bytes, so a URL there might be incomplete.
  let lastFullyConsumed = 0
  type Match = { url: string; kind: 'ui' | 'non-ui' | 'unknown' }
  const matches: Match[] = []
  URL_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_REGEX.exec(buffer)) !== null) {
    const end = m.index + m[0].length
    if (end === buffer.length) break
    matches.push({ url: m[0], kind: classify(buffer, m.index) })
    lastFullyConsumed = end
  }

  // When a batch contains both a UI-labeled URL and a non-UI one (typical
  // "Frontend: …  API: …" output from dev scripts), only the UI URL is worth
  // opening. If no UI label is present, fall back to unknown-labeled URLs
  // (still skipping anything explicitly tagged API/backend/etc.).
  const hasUi = matches.some((x) => x.kind === 'ui')
  const eligible = matches.filter((x) =>
    hasUi ? x.kind === 'ui' : x.kind === 'unknown',
  )
  // Cap to one open per batch to avoid the second URL clobbering the first
  // in the shared browser panel.
  const toOpen = eligible.slice(0, 1)
  // Mark every matched URL as seen — including ones we deliberately skip —
  // so future chunks don't re-trigger them.
  for (const { url } of matches) {
    const canonical = canonicalize(url)
    if (OPENED.has(canonical)) continue
    OPENED.add(canonical)
    if (OPENED.size > MAX_OPENED) {
      const first = OPENED.values().next().value as string | undefined
      if (first !== undefined) OPENED.delete(first)
    }
  }
  for (const { url } of toOpen) {
    const canonical = canonicalize(url)
    if (mode === 'auto') {
      openInBrowser(workspaceId, canonical)
    } else {
      useUrlPromptStore.getState().request(panelId, workspaceId, canonical)
    }
  }

  BUFFERS.set(panelId, buffer.slice(lastFullyConsumed))
}

export function clearTerminalUrlBuffer(panelId: string): void {
  BUFFERS.delete(panelId)
}
