// Cate's browser page protocol: what the page driver observes and returns.
// The runtime session, a client's view and its page driver share it.
export type BrowserPoint = [number, number]

export interface BrowserBinding {
  panelId: string
  tabId: string
}

export interface BrowserViewportState {
  width: number
  height: number
  zoom: number
  deviceScaleFactor: number
  scrollX: number
  scrollY: number
}

export interface BrowserImage {
  mimeType: 'image/jpeg' | 'image/png'
  data: string
  width: number
  height: number
}

export interface BrowserElement {
  id: number
  role: string
  name: string
  value?: unknown
  states?: Record<string, unknown>
  offscreen?: boolean
}

export interface BrowserObservation extends BrowserBinding {
  /** Image observations do not refresh numeric element IDs or accessibility state. */
  kind: 'ax' | 'image'
  observationId: string
  documentId: string
  url: string
  title: string
  viewport: BrowserViewportState
  state: string
  elements: BrowserElement[]
  diff: boolean
  screenshot?: BrowserImage
  /** Why an observation that asked for a screenshot has none. */
  screenshotError?: string
  performance?: BrowserObservationPerformance
}

export interface BrowserObservationPerformance {
  axMs: number
  frameWaitMs: number
  captureMs: number
  resizeMs: number
  encodeMs: number
  base64Ms: number
  totalMs: number
  imageBytes: number
  cacheEntries: number
  cacheEstimatedBytes: number
}

/** A JavaScript dialog (`alert`, `confirm`, `prompt`) a page is waiting on. */
export interface BrowserDialog {
  type: 'alert' | 'confirm' | 'prompt'
  message: string
  /** A prompt's default text. */
  defaultPrompt?: string
}

/** What an action did, printed above the observation after it. */
export interface BrowserActionOutcome {
  method: string
  status: 'verified' | 'dispatched'
  /** What else happened that the agent must act on (a file chooser opened). */
  notices?: string[]
}

/** The longest a page operation may wait (`waitFor`, click's wait for an
 *  actionable element). The settle and fresh observation after it come on top. */
export const BROWSER_WAIT_MAX_MS = 30_000

export const BROWSER_OBSERVATION_METHODS = new Set(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'])
export const BROWSER_ELEMENT_READ_METHODS = new Set(['getAttribute'])
export const BROWSER_ACTION_METHODS = new Set(['click', 'hover', 'setValue', 'typeText', 'pressKey', 'scroll', 'drag', 'selectText', 'setChecked', 'selectOption', 'upload', 'login', 'signup'])
/** The page's console messages and network requests, as the driver recorded them. */
export const BROWSER_LOG_METHODS = new Set(['console', 'network'])

export interface BrowserConsoleEntry {
  at: number
  level: 'error' | 'warning' | 'info' | 'log' | 'debug'
  text: string
  /** Where it came from, when Chromium says (`file:line`). */
  source?: string
}

export interface BrowserNetworkEntry {
  at: number
  method: string
  url: string
  /** Chromium's resource type (Document, XHR, Fetch, Script, ...). */
  type: string
  status?: number
  /** Why it failed (`net::ERR_...`); a failed request has no status. */
  error?: string
  durationMs?: number
}

/** The logical page a driver is bound to. */
export type BrowserPageIdentity = BrowserBinding

export type BrowserCursorKind = 'move' | 'click' | 'dblclick' | 'hover' | 'drag' | 'scroll' | 'type' | 'press'

/** One page-driver call's outcome. `cursor` is where the action happened, in
 *  guest viewport pixels, for the agent cursor overlay. */
export interface BrowserDriverResult {
  result?: unknown
  /** A JavaScript dialog the call left open (the page waits for its answer). */
  dialog?: BrowserDialog
  cursor?: { x?: number; y?: number; label: string; kind: BrowserCursorKind }
  error?: string
  recovery?: string
  observation?: BrowserObservation
}

/** How a panel lays out its page: the panel's own size, or a fixed emulated one. */
export type BrowserViewport =
  | { preset: 'compact' }
  | { preset: 'desktop' | 'mobile' | 'custom'; width: number; height: number }
