// `cate.browser.*`. Page operations are session methods on the target browser
// panel: they act on its active tab and reach the page through
// `withSurface()`. Elements are named by the numeric ids of the latest
// accessibility snapshot, or found by role and name (`--role button --name
// Save`). Tabs have short per-panel handles (`t2`); `listTabs` is a service
// method over every browser panel.

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
  str,
  path,
  type CateApiCliSpec,
  type CateApiMethodSpec,
} from '@kernel/api/contract'

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

const point = custom('[x,y]', isPoint).parseCli((raw) => parseJsonWord(raw, '[x,y]'))

/** An upload's element, or null (`chooser` on the CLI): the file chooser an
 *  earlier action opened. */
const uploadTarget = custom('element id, [x,y] or chooser', (value): value is number | Point | null =>
  value === null || (typeof value === 'number' && Number.isInteger(value)) || isPoint(value))
  .parseCli((raw) => (raw === 'chooser' ? null : /^\d+$/.test(raw) ? Number(raw) : parseJsonWord(raw, 'element id, [x,y] or chooser')))

/** A tab handle (`t2`). Bare numbers are element ids, so they are refused. */
const tabHandle = str.nonEmpty().parseCli((raw) => {
  if (/^\d+$/.test(raw)) throw new ArgError(`tab handles look like t${raw}, not ${raw} (numbers are element ids)`)
  return raw
})

/** Every page operation acts on the panel's active tab; `--tab` asserts which.
 *  A client caller may name the observation an action diffs against (the CLI
 *  uses the latest), and ask for a full tree instead of a diff. */
const tab = {
  tabId: opt(tabHandle).flag('tab', 'id').help('Fail unless this tab is the active one'),
  observationId: opt(str).hidden(),
  disableDiffing: opt(bool).hidden(),
}

const command = (word: string, summary: string): { summary: string; cli: CateApiCliSpec<any> } => ({ summary, cli: { command: ['browser', word] } })

// Page operations run alongside the panel's ops: the client reports the
// page's navigation and the person's tab switches while one waits.
function page<S extends Record<string, any>>(
  access: 'read' | 'control',
  args: S,
  cli: { summary: string; cli: CateApiCliSpec<any> },
): CateApiMethodSpec<typeof tab & S> & { handler: 'session'; args: typeof tab & S } {
  return {
    access,
    handler: 'session',
    concurrent: true,
    args: { ...tab, ...args },
    timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
    format: 'browserObservation',
    ...cli,
  }
}

/** Finds an element by the snapshot's role and name instead of an id. */
const locator = {
  role: opt(str.nonEmpty()).help('Find the element by role (button, link, textbox) instead of an id'),
  name: opt(str.nonEmpty()).help('Find the element by name: the quoted text in the snapshot (contains, any case)'),
  exact: opt(bool).help('--name must be the whole name, same case'),
}

const target = opt(elementTarget).pos('id').help('Element id from the latest snapshot, or [x,y]; or use --role/--name')
const located = { target, ...locator }

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
    detail: 'Browser actions and tabs: act on the page through the live browser panel.',
  },
})

/** `cate browser login` and `signup` need this on top of browser control;
 *  off unless the person turns it on. */
export const browserPasswordsCliArea = defineCliArea({
  label: 'Browser passwords',
  control: {
    key: 'cliBrowserPasswordsEnabled',
    code: 'browser-passwords-disabled',
    detail: '`cate browser login / signup`: fill a password saved in the browser into a sign-in form, or a new generated one into a sign-up form and save it. The agent never sees the password, but it can sign in with it.',
  },
})

export const browserApi = defineCateApi(
  'browser',
  {
    listTabs: {
      access: 'read',
      handler: 'service',
      summary: 'List the tabs of browser panels',
      args: { panelId: opt(panel('browser')).flag('panel', 'id').help('Only this browser panel') },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      format: 'browserTabs',
      cli: { command: ['browser', 'tab', 'list'] },
    },
    selectTab: {
      access: 'control',
      handler: 'session',
      concurrent: true,
      summary: 'Switch the panel to a tab and print its page',
      args: { tabId: tabHandle.pos('tab').help('Tab to show (from cate browser tab list)') },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      cli: { command: ['browser', 'tab', 'select'] },
    },
    createTab: {
      access: 'control',
      handler: 'session',
      concurrent: true,
      summary: 'Open a new tab, switch to it and print its handle',
      args: { url: opt(str).pos('url').help('URL to load (default: the new tab page)') },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      cli: { command: ['browser', 'tab', 'new'] },
    },
    closeTab: {
      access: 'control',
      handler: 'session',
      summary: 'Close a tab (default: the active one), or every tab you opened',
      args: {
        tabId: opt(tabHandle).pos('tab').help('Tab to close (default: the active one)'),
        mine: opt(bool).help('Close every tab you opened with cate browser tab new'),
      },
      timeoutMs: BROWSER_PAGE_TIMEOUT_MS,
      cli: { command: ['browser', 'tab', 'close'] },
    },
    goto: page('control', { url: str.nonEmpty().pos('url').help('URL, file path or search') }, command('goto', 'Load a URL in the tab')),
    back: page('control', {}, command('back', 'Go back')),
    forward: page('control', {}, command('forward', 'Go forward')),
    reload: page('control', {}, command('reload', 'Reload the page')),

    getAXState: page('read', {
      within: opt(num.int()).pos('id').help('Print only this element and what is inside it (an id from an earlier snapshot, such as the main landmark)'),
      screenshot: opt(bool).help('Also save a screenshot (needs the panel on screen)'),
      profile: opt(bool).help('Add phase timings'),
    }, command('snapshot', 'Print the accessibility tree with element ids')),
    getScreenshot: page('read', { profile: opt(bool).help('Add phase timings') }, command('screenshot', 'Save a screenshot of the viewport')),
    find: { ...page('read', locator, command('find', 'List the elements of the page that match --role and --name')), format: 'browserElements' },
    getAttribute: page('read', {
      ...located,
      attribute: str.nonEmpty().pos('name').help('Attribute name (href, src, value)'),
    }, command('attr', 'Print an attribute of an element')),
    waitFor: page('read', {
      text: opt(str).help('Wait until the page shows this text'),
      url: opt(str).help('Wait until the URL matches this glob (**/done)'),
      element: opt(num.int()).flag('element', 'id').help('Wait for this element to reach --state'),
      ...locator,
      state: opt(oneOf('visible', 'hidden', 'checked', 'unchecked', 'enabled', 'disabled')).help('State the element must reach (default visible)'),
      timeoutMs: opt(num.int().min(1).max(BROWSER_WAIT_MAX_MS)).flag('timeout', 'ms').help('How long to wait (default 5000)'),
    }, command('wait', 'Wait for text, a URL or an element state')),

    click: page('control', {
      ...located,
      mouseButton: opt(oneOf('left', 'right', 'middle')).flag('button').help('Mouse button (default left)'),
      clickCount: opt(num.int().min(1)).flag('count', 'n').help('2 for a double click'),
      timeoutMs: opt(num.int().min(0).max(BROWSER_WAIT_MAX_MS)).flag('timeout', 'ms').help('How long to wait for the element (default 5000)'),
    }, command('click', 'Click an element (or [x,y])')),
    hover: page('control', located, command('hover', 'Move the mouse over an element (or [x,y])')),
    setValue: page('control', { ...located, value: str.pos('text').help('The new text') }, command('fill', 'Replace the text of a field')),
    typeText: page('control', { text: str.rest('text').help('Text to insert at the selection') }, command('type', 'Type text at the focused field')),
    pressKey: page('control', { key: str.nonEmpty().pos('key').help('Key name or shortcut') }, command('press', 'Press a key or shortcut (Enter, Escape, Meta+a)')),
    scroll: page('control', {
      direction: oneOf('up', 'down', 'left', 'right').pos('direction').help('Direction to scroll'),
      target: opt(elementTarget).flag('target', 'id').help('Element (or [x,y]) to scroll; default: the viewport'),
      pages: opt(num.min(0), 1).help('Viewports to scroll'),
    }, command('scroll', 'Scroll the page or an element')),
    drag: page('control', {
      from: point.pos('from').help('Where to press, [x,y] in the viewport'),
      to: point.pos('to').help('Where to release, [x,y]'),
    }, command('drag', 'Drag with the mouse from one point to another')),
    selectText: page('control', {
      ...located,
      text: str.nonEmpty().pos('text').help('The text inside the element to select'),
      cursor: opt(oneOf('before', 'after')).help('Put the cursor before or after the text instead of selecting it'),
    }, command('select-text', 'Select text inside a field or element')),
    setChecked: page('control', { ...located, checked: opt(bool, true).help('--no-checked to uncheck') }, command('check', 'Check a checkbox or radio (--no-checked unchecks)')),
    selectOption: page('control', {
      ...located,
      values: custom('value or values', (v): v is unknown => v !== undefined).rest('value')
        .parseCli((raw) => (raw.startsWith('[') ? parseJsonWord(raw, 'JSON array of values') : raw))
        .help('Option value, or a JSON array for a multiple select'),
    }, command('select', 'Choose an option of a select by value')),
    upload: page('control', {
      target: opt(uploadTarget).pos('id').help('The file input, its label, or the button or drop area that opens the file chooser; "chooser" for the chooser an action opened'),
      ...locator,
      files: arr(path).rest('file').help('Files to upload (several for an input that takes several)'),
      drop: opt(bool).help('Drop the files on the element (or [x,y]) instead, for a drop area with no file chooser'),
    }, command('upload', 'Choose files for a file input or drop area')),
    login: { ...page('control', {
      target: opt(elementTarget).pos('id').help('The password or username field, or the sign-in form (default: the page\'s)'),
      username: opt(str).flag('user', 'name').help('Which saved login, when the site has several'),
    }, command('login', 'Fill a saved login into the sign-in form (the password never reaches you)')), optIn: browserPasswordsCliArea },
    signup: { ...page('control', {
      target: opt(elementTarget).pos('id').help('The password field or the sign-up form (default: the page\'s)'),
      username: str.nonEmpty().flag('user', 'name').help('The username or email the account signs in with, to save the login under'),
    }, command('signup', 'Fill a new generated password into the sign-up form and save it as this site\'s login (the password never reaches you)')), optIn: browserPasswordsCliArea },
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
    download: page('control', { url: opt(str).pos('url').help('URL to download, relative to the page (default: the page itself)') }, command('download', 'Download a URL through the tab')),
    downloads: { ...page('read', {}, command('downloads', 'List the panel\'s downloads')), format: 'browserDownloads' },

    setViewport: page('control', {
      preset: oneOf('compact', 'mobile', 'desktop', 'custom').pos('preset').help('compact follows the panel size; custom takes --width and --height'),
      width: opt(num.min(1)).help('Viewport width in CSS pixels'),
      height: opt(num.min(1)).help('Viewport height in CSS pixels'),
    }, command('viewport', 'Set the page\'s viewport size')),
    resize: page('control', {
      width: num.min(1).pos('width').help('Panel width'),
      height: num.min(1).pos('height').help('Panel height'),
    }, command('resize', 'Resize the browser panel on its canvas')),
  },
  { area: browserCliArea, summary: 'Control browser panels' },
)
