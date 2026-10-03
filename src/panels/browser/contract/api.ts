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

export const browserApi = defineCateApi(
  'browser',
  {
    run: {
      access: 'control',
      handler: 'service',
      summary: 'Run JavaScript in your persistent browser code session',
      args: {
        code: str.nonEmpty().pos('JavaScript').help('JavaScript to run, quoted as one argument'),
        panelId: opt(panel('browser')).flag('panel', 'id').help('Default browser panel for the cell'),
      },
      timeoutMs: BROWSER_CODE_TIMEOUT_MS,
      format: 'browserContent',
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
  { area: 'browser', summary: 'Control browser panels with JavaScript' },
)
