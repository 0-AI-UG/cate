// =============================================================================
// consoleBuffer — per-panel ring buffer of guest console output.
//
// Fed by BrowserPanel's `console-message` webview listener, NOT by injecting a
// console shim into the page. That matters: an injected shim only sees messages
// logged after it runs and dies on every navigation, so it would silently miss
// exactly the errors an agent is looking for (the ones thrown during load).
// The webview event is attached before the guest is dom-ready and survives
// navigations for the panel's whole mounted life.
//
// Bounded: a page in a render loop can log thousands of lines a second, and this
// buffer is only ever read as "the recent tail".
// =============================================================================

export interface ConsoleEntry {
  /** Chromium level: 0 verbose, 1 info, 2 warning, 3 error. Normalized to a
   *  name so callers never have to know the numbering. */
  level: 'verbose' | 'info' | 'warning' | 'error'
  message: string
  source: string
  line: number
  at: number
}

const MAX_ENTRIES = 500
const MAX_MESSAGE = 2_000

const byPanelId = new Map<string, ConsoleEntry[]>()

const LEVELS: ConsoleEntry['level'][] = ['verbose', 'info', 'warning', 'error']

export function recordConsoleMessage(
  panelId: string,
  level: number,
  message: string,
  source: string,
  line: number,
): void {
  const entries = byPanelId.get(panelId) ?? []
  entries.push({
    level: LEVELS[level] ?? 'info',
    message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
    source,
    line,
    at: Date.now(),
  })
  while (entries.length > MAX_ENTRIES) entries.shift()
  byPanelId.set(panelId, entries)
}

/** The most recent `max` entries (newest last), optionally only at/above a
 *  minimum level — an agent chasing a bug wants errors, not every log line. */
export function readConsole(
  panelId: string,
  max = 100,
  minLevel?: ConsoleEntry['level'],
): ConsoleEntry[] {
  const entries = byPanelId.get(panelId) ?? []
  const floor = minLevel ? LEVELS.indexOf(minLevel) : 0
  const filtered = floor > 0 ? entries.filter((e) => LEVELS.indexOf(e.level) >= floor) : entries
  return max > 0 ? filtered.slice(-max) : filtered
}

export function clearConsole(panelId: string): void {
  byPanelId.delete(panelId)
}
