// `cate.browser.*`. `run` and `reset` drive the caller's persistent JavaScript
// code session; they belong to the caller, not to one panel, so they are
// service methods the browser module registers. Page operations are what code
// cells call on a tab: session methods on the target browser panel, which reach
// the page through `withSurface()`. Page operations stay off the CLI; the CLI
// reaches them through `run`.

import {
  bool,
  custom,
  defineCateApi,
  num,
  oneOf,
  opt,
  panel,
  record,
  str,
  type CateApiMethodSpec,
} from '@kernel/api/contract'

export const BROWSER_CODE_TIMEOUT_MS = 40_000
export const BROWSER_PAGE_TIMEOUT_MS = 35_000

type Point = [number, number]

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))

/** A numeric element id from the latest AX observation, or a viewport point. */
const elementTarget = custom('element id or [x,y]', (value): value is number | Point =>
  (typeof value === 'number' && Number.isInteger(value)) || isPoint(value))

const point = custom('[x,y]', isPoint)

const tab = { tabId: str, observationId: opt(str) }

// Option bags pass through (click options, waitFor options, observation flags).
function page<S extends Record<string, any>>(
  access: 'read' | 'control',
  args: S,
): CateApiMethodSpec<typeof tab & S> & { handler: 'session'; args: typeof tab & S } {
  return {
    access,
    handler: 'session',
    args: { ...tab, ...args },
    extraArgs: true,
    timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
    cli: { command: false },
  }
}

const observe = {
  disableDiffing: opt(bool),
  emit: opt(bool),
  profile: opt(bool),
}

export const BROWSER_CODE_HELP = `Cate browser control runs JavaScript in a persistent, isolated session. No Node.js, filesystem, network, DOM evaluation, or browser engine access is exposed. Use only cua and output helpers.

Start with: var tab = await cua.getTab({panelId: "..."});
Or, in an existing browser panel: var tab = await cua.createBrowserTab("https://example.com");
Create a browser panel first with cate panel create browser [url] when needed.
await cua.listTabs(); // discover panelId and tabId
Tab bindings pin panel and tab; they never follow a user's tab switch.

Observation methods return structured observations and emit their state/images automatically:
await tab.getAXState({disableDiffing: false});
await tab.getScreenshot();
await tab.getAXStateAndScreenshot();
await tab.getAttribute(42, "src"); // string or null; target must be in the latest AX observation
Options: emit:false suppresses output. disableDiffing:true requests a full tree.
Each cell has a 16-million-character retained-observation budget, including emit:false; split long screenshot loops across cells.
Observations contain kind, observationId, documentId, url, title and viewport. AX observations (kind:"ax") contain elements with numeric id, role, name, value and states. getScreenshot returns kind:"image": only viewport pixels/identity, empty state/elements, no AX scan. It does not refresh numeric IDs; the SDK retains the last AX observation separately and uses the latest visual observation for coordinates. getAXStateAndScreenshot refreshes both together. CLI output saves image artifacts; open them with an image-viewing tool.
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

Lifecycle: tab.goto(url), tab.back(), tab.forward(), tab.reload(), tab.close(), tab.setViewport({width:1280,height:800}), tab.resize({width:800,height:600}), tab.download(url?), tab.downloads().
tab.download() downloads the current tab URL; pass an absolute or page-relative URL to download a known asset without navigating. Use tab.downloads() to inspect progress and completion.
Use var for reusable bindings; top-level await is supported. Batch only deterministic actions, then inspect state before deciding again. Each code call has a deadline; await every action. A timed-out session resets. Use nodeRepl.write(value) for additional text. CLI prints labeled image artifact paths; --json includes base64 data for structured consumers.`

export const browserApi = defineCateApi(
  'browser',
  {
    run: {
      access: 'control',
      handler: 'service',
      summary: 'Run JavaScript in your persistent browser code session',
      args: {
        code: str.nonEmpty().pos('JavaScript'),
        panelId: opt(panel('browser')).flag('panel', 'id').help('Default browser panel for the cell'),
      },
      timeoutMs: BROWSER_CODE_TIMEOUT_MS,
      format: 'browserContent',
      cli: { help: BROWSER_CODE_HELP },
    },
    reset: {
      access: 'control',
      handler: 'service',
      summary: 'Clear your code session bindings (tabs stay open)',
      timeoutMs: BROWSER_CODE_TIMEOUT_MS,
      format: 'browserContent',
    },
    listTabs: {
      access: 'read',
      handler: 'service',
      args: { panelId: opt(panel('browser')) },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      cli: { command: false },
    },
    getTab: {
      access: 'control',
      handler: 'session',
      args: { tabId: opt(str) },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      cli: { command: false },
    },
    createTab: {
      access: 'control',
      handler: 'session',
      args: { url: opt(str) },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      cli: { command: false },
    },

    getAXState: page('read', observe),
    getScreenshot: page('read', observe),
    getAXStateAndScreenshot: page('read', observe),
    getAttribute: page('read', { target: elementTarget, name: str }),
    waitFor: page('read', { condition: record(custom('value', (v): v is unknown => v !== undefined)) }),
    downloads: page('read', {}),

    click: page('control', {
      target: elementTarget,
      mouseButton: opt(oneOf('left', 'right', 'middle')),
      clickCount: opt(num.int().min(1)),
    }),
    setValue: page('control', { target: elementTarget, value: custom('value', (v): v is unknown => v !== undefined) }),
    typeText: page('control', { text: str }),
    pressKey: page('control', { key: str.nonEmpty() }),
    scroll: page('control', {
      target: elementTarget,
      direction: oneOf('up', 'down', 'left', 'right'),
      pages: opt(num.min(0), 1),
    }),
    drag: page('control', { from: point, to: point }),
    selectText: page('control', {
      target: elementTarget,
      text: str,
      selectionType: opt(oneOf('text', 'cursor_before', 'cursor_after')),
    }),
    setChecked: page('control', { target: elementTarget, checked: bool }),
    selectOption: page('control', { target: elementTarget, values: custom('value or values', (v): v is unknown => v !== undefined) }),
    upload: page('control', { target: elementTarget, filePath: str.nonEmpty() }),
    goto: page('control', { url: str.nonEmpty() }),
    back: page('control', {}),
    forward: page('control', {}),
    reload: page('control', {}),
    close: page('control', {}),
    setViewport: page('control', {
      preset: opt(oneOf('compact', 'mobile', 'desktop', 'custom')),
      width: opt(num.min(1)),
      height: opt(num.min(1)),
    }),
    resize: page('control', { width: num.min(1), height: num.min(1) }),
    download: page('control', { url: opt(str) }),
  },
  {
    area: 'browser',
    help: 'Browser code runs in a persistent isolated session against Cate\'s live tabs.',
  },
)
