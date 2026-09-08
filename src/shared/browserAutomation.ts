/** Cate's browser target protocol. The CLI and code tool share this contract. */
export type BrowserPoint = [number, number]
export type BrowserElementTarget = number | BrowserPoint

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
export const BROWSER_ACTION_METHODS = new Set(['click', 'setValue', 'typeText', 'pressKey', 'scroll', 'drag', 'selectText', 'setChecked', 'selectOption', 'upload'])
export const BROWSER_LIFECYCLE_METHODS = new Set(['getTab', 'listTabs', 'createTab', 'goto', 'back', 'forward', 'reload', 'close', 'setViewport', 'resize', 'downloads'])
export const BROWSER_METHODS = new Set([...BROWSER_OBSERVATION_METHODS, ...BROWSER_ACTION_METHODS, ...BROWSER_LIFECYCLE_METHODS, 'waitFor'])
export const BROWSER_READ_METHODS = new Set([...BROWSER_OBSERVATION_METHODS, 'listTabs', 'downloads', 'waitFor'])

export const BROWSER_API_DOCUMENTATION = `Cate browser control runs JavaScript in a persistent, isolated session. No Node.js, filesystem, network, DOM evaluation, or browser engine access is exposed. Use only cua and output helpers.

Start with: var tab = await cua.getTab({panelId: "..."});
Or: var tab = await cua.createBrowserTab("https://example.com");
await cua.listTabs(); // discover panelId and tabId
Tab bindings pin panel and tab; they never follow a user's tab switch.

Observation methods return structured observations and emit their state/images automatically:
await tab.getAXState({disableDiffing: false});
await tab.getScreenshot();
await tab.getAXStateAndScreenshot();
Options: emit:false suppresses output. disableDiffing:true requests a full tree.
Each cell has a 16-million-character retained-observation budget, including emit:false; split long screenshot loops across cells.
Observations contain kind, observationId, documentId, url, title and viewport. AX observations (kind:"ax") contain elements with numeric id, role, name, value and states. getScreenshot returns kind:"image": only viewport pixels/identity, empty state/elements, no AX scan. It does not refresh numeric IDs; the SDK retains the last AX observation separately and uses the latest visual observation for coordinates. getAXStateAndScreenshot refreshes both together. Images are returned directly to the model.
Optional profile:true reports observation phase timings, encoded image bytes and estimated retained-cache bytes. The cache retains up to 32 compact observations within an 8 MiB estimated allocation budget; an evicted baseline requires observing again.

Act using IDs from the latest AX observation:
await tab.click(42, {mouseButton:"left", clickCount:1});
await tab.setValue(17, "replacement text");
await tab.typeText("insert at current selection");
await tab.pressKey("Return");
await tab.selectText(17, "text", {selectionType:"text"}); // cursor_before or cursor_after also supported
await tab.scroll(42, "down", 1); // or [x,y], direction up/down/left/right; pages default 1
await tab.drag([100,100], [300,200]);
await tab.setChecked(42, true);
await tab.selectOption(42, ["value"]);
await tab.upload(42, "/authorized/file");
await tab.waitFor({text:"Saved"}); // or url glob, element:number + state: visible/hidden/checked/unchecked/enabled/disabled

Actions return and emit fresh state; input dispatch is not proof of business completion. Use waitFor or inspect resulting state to verify. Numeric IDs survive observations within a document; navigation requires fresh IDs. Coordinates use the latest screenshot/observation and are rejected after viewport changes. Do not guess IDs or coordinates.

Lifecycle: tab.goto(url), tab.back(), tab.forward(), tab.reload(), tab.close(), tab.setViewport({width:1280,height:800}), tab.resize({width:800,height:600}), tab.downloads().
Use var for reusable bindings; top-level await is supported. Batch only deterministic actions, then inspect state before deciding again. Each code call has a deadline; await every action. A timed-out session resets. Use nodeRepl.write(value) for additional text. The browser tool returns actual images; CLI prints image artifact paths instead.
`
