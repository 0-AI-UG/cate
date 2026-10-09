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
  mimeType: 'image/png'
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
  /** Allows a multi-step controller to stop after user input between calls. */
  userInputEpoch?: number
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
  performance?: BrowserObservationPerformance
}

export interface BrowserObservationPerformance {
  axMs: number
  frameWaitMs: number
  captureMs: number
  resizeMs: number
  pngMs: number
  base64Ms: number
  totalMs: number
  imageBytes: number
  cacheEntries: number
  cacheEstimatedBytes: number
}

export type BrowserContent = { type: 'text'; text: string } | { type: 'image'; mimeType: 'image/png'; data: string }

export interface BrowserCodeResult {
  content: BrowserContent[]
  isError?: boolean
}

export const BROWSER_OBSERVATION_METHODS = new Set(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'])
export const BROWSER_ELEMENT_READ_METHODS = new Set(['getAttribute'])
export const BROWSER_ACTION_METHODS = new Set(['click', 'setValue', 'typeText', 'pressKey', 'scroll', 'drag', 'selectText', 'setChecked', 'selectOption', 'upload'])
const BROWSER_LIFECYCLE_METHODS = new Set(['getTab', 'listTabs', 'createTab', 'goto', 'back', 'forward', 'reload', 'close', 'setViewport', 'resize', 'download', 'downloads'])
export const BROWSER_METHODS = new Set([...BROWSER_OBSERVATION_METHODS, ...BROWSER_ELEMENT_READ_METHODS, ...BROWSER_ACTION_METHODS, ...BROWSER_LIFECYCLE_METHODS, 'waitFor'])

/** The logical page a driver is bound to. */
export type BrowserPageIdentity = BrowserBinding

export type BrowserCursorKind = 'move' | 'click' | 'dblclick' | 'hover' | 'drag' | 'scroll' | 'type' | 'press'

/** One page-driver call's outcome. `cursor` is where the action happened, in
 *  guest viewport pixels, for the agent cursor overlay. */
export interface BrowserDriverResult {
  result?: unknown
  cursor?: { x?: number; y?: number; label: string; kind: BrowserCursorKind }
  error?: string
  recovery?: string
  observation?: BrowserObservation
}

/** How a panel lays out its page: the panel's own size, or a fixed emulated one. */
export type BrowserViewport =
  | { preset: 'compact' }
  | { preset: 'desktop' | 'mobile' | 'custom'; width: number; height: number }
