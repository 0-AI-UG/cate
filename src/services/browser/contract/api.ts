// `cate.browser.*`. `run` and `reset` drive the caller's persistent JavaScript
// code session; they belong to the caller, not to one panel, so they are
// service methods the browser module registers. Page operations are what code
// cells call on a tab: session methods on the target browser panel, which reach
// the page through `withSurface()`. The common page operations are also CLI
// commands (`cate browser click 12`) on the active tab of the target panel.

import { BROWSER_WAIT_MAX_MS } from './automation'
import {
  ArgError,
  arr,
  bool,
  custom,
  defineCateApi,
  defineCliArea,
  num,
  oneOf,
  opt,
  panel,
  record,
  str,
  path,
  type CateApiCliSpec,
  type CateApiMethodSpec,
} from '@kernel/api/contract'

export const BROWSER_CODE_TIMEOUT_MS = 40_000
/** A page operation's deadline: its longest wait, then the driver's settle
 *  (up to about 6.5 s) and a fresh observation, so a timed-out wait still
 *  reports the driver's error and hint rather than an RPC timeout. */
export const BROWSER_PAGE_TIMEOUT_MS = BROWSER_WAIT_MAX_MS + 15_000

type Point = [number, number]

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))

/** A CLI word as JSON; bad JSON is a usage error, not a crash. */
function parseJsonWord(raw: string, expected: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new ArgError(`invalid ${expected}: ${raw}`)
  }
}

/** A numeric element id from the latest AX observation, or a viewport point. */
const elementTarget = custom('element id or [x,y]', (value): value is number | Point =>
  (typeof value === 'number' && Number.isInteger(value)) || isPoint(value))
  .parseCli((raw) => (/^\d+$/.test(raw) ? Number(raw) : parseJsonWord(raw, 'element id or [x,y]')))

const point = custom('[x,y]', isPoint)

/** An upload's element, or null (`chooser` on the CLI): the file chooser an
 *  earlier action opened. */
const uploadTarget = custom('element id, [x,y] or chooser', (value): value is number | Point | null =>
  value === null || (typeof value === 'number' && Number.isInteger(value)) || isPoint(value))
  .parseCli((raw) => (raw === 'chooser' ? null : /^\d+$/.test(raw) ? Number(raw) : parseJsonWord(raw, 'element id, [x,y] or chooser')))

/** Code cells bind a tab and carry their observation; a CLI command acts on
 *  the panel's active tab and its latest observation. */
const tab = {
  tabId: opt(str).flag('tab', 'id').help('Tab to act on (default: the active tab)'),
  observationId: opt(str).hidden(),
}

const command = (word: string, summary: string): { summary: string; cli: CateApiCliSpec<any> } => ({ summary, cli: { command: ['browser', word] } })

// Option bags pass through (click options, waitFor options, observation flags).
// Page operations run alongside the panel's ops: the client reports the
// page's navigation and the person's tab switches while one waits.
function page<S extends Record<string, any>>(
  access: 'read' | 'control',
  args: S,
  cli?: { summary: string; cli: CateApiCliSpec<any> },
): CateApiMethodSpec<typeof tab & S> & { handler: 'session'; args: typeof tab & S } {
  return {
    access,
    handler: 'session',
    concurrent: true,
    args: { ...tab, ...args },
    extraArgs: true,
    timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
    format: 'browserObservation',
    ...(cli ?? { cli: { command: false } }),
  }
}

const observe = {
  disableDiffing: opt(bool).hidden(),
  emit: opt(bool).hidden(),
  profile: opt(bool).help('Add phase timings'),
}

const target = elementTarget.pos('id').help('Element id from the latest snapshot, or [x,y]')

/** The CLI permission area of these methods. */
export const browserCliArea = defineCliArea({
  label: 'Browser',
  read: {
    key: 'cliBrowserReadEnabled',
    code: 'browser-read-disabled',
    detail:
      'Accessibility state, element attributes, screenshots, tabs and waits: inspect the page in the built-in browser panel, which shows your live logged-in sessions.',
  },
  control: {
    key: 'cliBrowserControlEnabled',
    code: 'browser-control-disabled',
    detail: 'Browser JavaScript sessions and actions: act on the page through the live browser panel.',
  },
})

export const browserApi = defineCateApi(
  'browser',
  {
    run: {
      access: 'control',
      handler: 'service',
      summary: 'Run JavaScript in your persistent browser code session',
      args: {
        code: str.nonEmpty().pos('JavaScript').help('JavaScript to run, quoted as one argument'),
        panelId: opt(panel('browser')).flag('panel', 'id').help('Browser panel the cell drives (default: as for other browser commands)'),
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
      summary: 'List the tabs of browser panels',
      args: { panelId: opt(panel('browser')).flag('panel', 'id').help('Only this browser panel') },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      format: 'browserTabs',
      cli: { command: ['browser', 'tabs'] },
    },
    getTab: {
      access: 'control',
      handler: 'session',
      concurrent: true,
      summary: 'Show a tab (default: the active one) and print its id, URL and title',
      args: { tabId: opt(str).pos('tab-id').help('Tab to show (from cate browser tabs)') },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      cli: { command: ['browser', 'tab'] },
    },
    createTab: {
      access: 'control',
      handler: 'session',
      concurrent: true,
      summary: 'Open a new tab and print its id, URL and title',
      args: { url: opt(str).pos('url').help('URL to load (default: the new tab page)') },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      cli: { command: ['browser', 'open'] },
    },

    getAXState: page('read', observe, command('snapshot', 'Print the accessibility tree with element ids')),
    getScreenshot: page('read', observe, command('screenshot', 'Save a screenshot of the viewport')),
    getAXStateAndScreenshot: page('read', observe),
    getAttribute: page('read', { target, name: str.pos('name').help('Attribute name (href, src, value)') }, command('attr', 'Print an attribute of an element')),
    waitFor: page('read', {
      condition: opt(record(custom('value', (v): v is unknown => v !== undefined))).hidden(),
      text: opt(str).help('Wait until the page shows this text'),
      url: opt(str).help('Wait until the URL matches this glob (**/done)'),
      element: opt(num.int()).flag('element', 'id').help('Wait for this element to reach --state'),
      state: opt(oneOf('visible', 'hidden', 'checked', 'unchecked', 'enabled', 'disabled')).help('State --element must reach (default visible)'),
      timeoutMs: opt(num.int().min(1).max(BROWSER_WAIT_MAX_MS)).flag('timeout', 'ms').help('How long to wait (default 5000)'),
    }, command('wait', 'Wait for text, a URL or an element state')),
    downloads: page('read', {}),

    click: page('control', {
      target,
      mouseButton: opt(oneOf('left', 'right', 'middle')).flag('button').help('Mouse button (default left)'),
      clickCount: opt(num.int().min(1)).flag('count', 'n').help('2 for a double click'),
      timeoutMs: opt(num.int().min(0).max(BROWSER_WAIT_MAX_MS)).flag('timeout', 'ms').help('How long to wait for the element to be clickable (default 5000)'),
    }, command('click', 'Click an element (or [x,y])')),
    hover: page('control', { target }, command('hover', 'Move the mouse over an element (or [x,y])')),
    setValue: page('control', { target, value: custom('value', (v): v is unknown => v !== undefined).pos('text').parseCli((raw) => raw).help('The new text') }, command('fill', 'Replace the text of a field')),
    typeText: page('control', { text: str.rest('text').help('Text to insert at the selection') }, command('type', 'Type text at the focused field')),
    pressKey: page('control', { key: str.nonEmpty().pos('key').help('Key name or shortcut') }, command('press', 'Press a key or shortcut (Enter, Escape, Meta+a)')),
    scroll: page('control', {
      direction: oneOf('up', 'down', 'left', 'right').pos('direction').help('Direction to scroll'),
      target: opt(elementTarget).flag('target', 'id').help('Element (or [x,y]) to scroll; default: the viewport'),
      pages: opt(num.min(0), 1).help('Viewports to scroll'),
    }, command('scroll', 'Scroll the page or an element')),
    drag: page('control', { from: point, to: point }),
    selectText: page('control', {
      target: elementTarget,
      text: str,
      selectionType: opt(oneOf('text', 'cursor_before', 'cursor_after')),
    }),
    setChecked: page('control', { target, checked: opt(bool, true).help('--no-checked to uncheck') }, command('check', 'Check a checkbox or radio (--no-checked unchecks)')),
    selectOption: page('control', {
      target,
      values: custom('value or values', (v): v is unknown => v !== undefined).rest('value')
        .parseCli((raw) => (raw.startsWith('[') ? parseJsonWord(raw, 'JSON array of values') : raw))
        .help('Option value, or a JSON array for a multiple select'),
    }, command('select', 'Choose an option of a select by value')),
    upload: page('control', {
      target: opt(uploadTarget).pos('id').help('The file input, its label, or the button or drop area that opens the file chooser; "chooser" for the chooser an action opened'),
      files: arr(path).rest('file').help('Files to upload (several for an input that takes several)'),
      drop: opt(bool).help('Drop the files on the element (or [x,y]) instead, for a drop area with no file chooser'),
    }, command('upload', 'Choose files for a file input or drop area')),
    login: page('control', {
      target: opt(elementTarget).pos('id').help('The password or username field, or the sign-in form (default: the page\'s)'),
      username: opt(str).flag('user', 'name').help('Which saved login, when the site has several'),
    }, command('login', 'Fill a saved login into the sign-in form (the password never reaches you)')),
    dialog: page('control', {
      action: oneOf('accept', 'dismiss').pos('action').help('accept (OK) or dismiss (Cancel)'),
      text: opt(str).help('The answer to a prompt (default: its default text)'),
    }, command('dialog', 'Answer the alert, confirm or prompt the page waits on')),
    console: { ...page('read', {
      level: opt(oneOf('all', 'error', 'warning')).help('Only errors, or errors and warnings (default all)'),
      limit: opt(num.int().min(1).max(500)).help('How many of the newest to print (default 100)'),
      clear: opt(bool).help('Forget the messages after printing them'),
    }, command('console', 'Print the page\'s console messages and uncaught errors')), format: 'browserConsole' },
    network: { ...page('read', {
      failed: opt(bool).help('Only failed requests and error statuses (4xx, 5xx)'),
      filter: opt(str).help('Only URLs containing this text'),
      limit: opt(num.int().min(1).max(500)).help('How many of the newest to print (default 100)'),
      clear: opt(bool).help('Forget the requests after printing them'),
    }, command('network', 'Print the page\'s network requests')), format: 'browserNetwork' },
    goto: page('control', { url: str.nonEmpty().pos('url').help('URL, file path or search') }, command('goto', 'Load a URL in the tab')),
    back: page('control', {}, command('back', 'Go back')),
    forward: page('control', {}, command('forward', 'Go forward')),
    reload: page('control', {}, command('reload', 'Reload the page')),
    close: page('control', {}),
    setViewport: page('control', {
      preset: opt(oneOf('compact', 'mobile', 'desktop', 'custom')),
      width: opt(num.min(1)),
      height: opt(num.min(1)),
    }),
    resize: page('control', { width: num.min(1), height: num.min(1) }),
    download: page('control', { url: opt(str) }),
  },
  { area: browserCliArea, summary: 'Control browser panels with JavaScript' },
)
