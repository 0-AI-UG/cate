// Agent control of one browser panel's pages (architecture 10.2): the
// `cate.browser.*` page methods. Each runs on the panel's active tab, through
// page operations on the driving client (`page.*`), and fails fast when a
// person picks another tab meanwhile. The panel's session holds the tabs and
// hands this its port; the methods about tabs and the panel itself
// (`selectTab`, `closeTab`, `setViewport`, ...) stay the session's.

import type { ApiSessionContext, CateSessionHandlers } from '@kernel/api/contract'
import { RpcError } from '@kernel/rpc/contract'
import type { AgentCursorEvent, AgentCursorKind } from '../contract/agentCursor'
import type { browserApi } from '../contract/api'
import { BROWSER_ACTION_METHODS, type BrowserDriverResult } from '../contract/automation'
import type { BrowserSurfaceArgs, BrowserSurfaceOp, BrowserSurfaceResult } from '../contract/surface'
import { credentialOrigin } from '../contract/history'
import { BROWSER_NEW_TAB_URL } from '../contract/types'
import { generatePassword, type PasswordStore } from './passwords'

/** A page operation's deadline and cancellation. */
export interface PageCall {
  timeoutMs?: number
  signal?: AbortSignal
}

/** A tab as page control sees it. `internal`: a page the view draws itself
 *  (history, passwords), which has no web page to act on. */
export interface PageControlTab {
  id: string
  url: string
  nav: number
  internal: boolean
}

/** What the panel's session hands page control. */
export interface PageControlPanel {
  readonly panelId: string
  activeTabId(): string
  /** What made the active tab active (`the person switched to it`), if known. */
  activeTabCause(): string | null
  /** Throws `gone` for an unknown tab. */
  tab(tabId: string): PageControlTab
  isDisposed(): boolean
  /** Sets a tab's URL for every client to load; returns its new `nav`. */
  navigateTab(tabId: string, input: string): Promise<number>
  /** Runs a page operation on the panel's driving client. */
  surface<Op extends BrowserSurfaceOp>(op: Op, args: BrowserSurfaceArgs<Op>, call?: PageCall): Promise<BrowserSurfaceResult<Op>>
  /** Shows what the agent does in the panel's agent cursor. */
  showCursor(event: AgentCursorEvent): void
}

export interface PageControlDeps {
  /** The workspace's saved passwords, for an agent's `login`. */
  passwords: Pick<PasswordStore, 'suggestions' | 'forFill' | 'save'>
}

/** The session methods of `cate.browser.*` that page control answers. */
export type PageControlHandlers = Omit<CateSessionHandlers<typeof browserApi>, 'selectTab' | 'createTab' | 'closeTab' | 'downloads' | 'setViewport' | 'resize'>

export interface PageControl {
  handlers: PageControlHandlers
  /** The active tab `tabId` (the active tab when the call names none), with a
   *  web page or the start page. */
  boundTab(tabId: unknown): PageControlTab
  /** Throws once the panel is gone or `tabId` is no longer its active tab. */
  still(tabId: string): void
  /** One page-driver method on the tab; `settle` waits for layout first. */
  execute(tabId: string, method: string, args: Record<string, unknown>, settle: boolean, call?: PageCall): Promise<unknown>
  /** The tab's page once it followed the tab's navigation. */
  pageInfo(tabId: string, call: PageCall): Promise<{ panelId: string; tabId: string; url: string; title: string }>
}

/** A page operation for a `cate` API call: the call's deadline and
 *  cancellation (its signal) govern, not the broker's default timeout. */
export const pageCall = (ctx: ApiSessionContext): PageCall => ({ timeoutMs: 0, signal: ctx.signal })

function cursorKind(method: string): AgentCursorKind {
  if (method === 'setValue' || method === 'typeText' || method === 'login' || method === 'signup') return 'type'
  if (method === 'hover') return 'hover'
  if (method === 'pressKey') return 'press'
  if (method === 'scroll') return 'scroll'
  return 'move'
}

const hasPage = (tab: PageControlTab) => !tab.internal && tab.url !== BROWSER_NEW_TAB_URL

export function createPageControl(panel: PageControlPanel, deps: PageControlDeps): PageControl {
  /** A bound tab that is no longer the panel's active one. */
  const tabChanged = (tabId: string): RpcError => {
    const active = panel.activeTabId()
    const cause = panel.activeTabCause()
    return new RpcError('rejected', `browser-tab-changed: the panel now shows tab ${active}, not ${tabId}${cause ? ` (${cause})` : ''}. `
      + `Run the command again to act on ${active}, or switch back with cate browser tab select ${tabId} --panel ${panel.panelId}.`)
  }

  // A person's tab switch cancels work bound to the tab it left.
  const boundTab = (tabId: unknown): PageControlTab => {
    if (tabId !== undefined && typeof tabId !== 'string') throw new RpcError('rejected', 'tabId-required')
    const active = panel.activeTabId()
    if (tabId !== undefined && tabId !== active) throw tabChanged(tabId)
    const tab = panel.tab(active)
    if (tab.internal) throw new RpcError('rejected', 'The active tab has no web page')
    return tab
  }

  const still = (tabId: string): void => {
    if (panel.isDisposed()) throw new RpcError('gone', `panel ${panel.panelId} is gone`)
    if (panel.activeTabId() !== tabId) throw tabChanged(tabId)
  }

  const execute = async (tabId: string, method: string, args: Record<string, unknown>, settle: boolean, call?: PageCall): Promise<unknown> => {
    const response: BrowserDriverResult = await panel.surface('page.execute', { tabId, method, args, ...(settle ? { settle } : {}) }, call)
    if (response.cursor) panel.showCursor(response.cursor)
    // A multi-line error (the matches of an ambiguous locator) gets its hint on a line of its own.
    if (response.error) throw new RpcError('rejected', response.recovery ? `${response.error}${response.error.includes('\n') ? '\n' : ': '}${response.recovery}` : response.error)
    return response.result
  }

  const pageInfo = async (tabId: string, call: PageCall) => {
    const tab = panel.tab(tabId)
    if (tab.internal) throw new RpcError('rejected', 'The active tab has no web page')
    const page = await panel.surface('page.ready', { tabId, nav: tab.nav }, call)
    still(tabId)
    return { panelId: panel.panelId, tabId, ...page }
  }

  const observeAfterNavigation = async (tabId: string, args: Record<string, unknown>, call: PageCall): Promise<unknown> => {
    await panel.surface('page.ready', { tabId, nav: panel.tab(tabId).nav }, call)
    still(tabId)
    return execute(tabId, 'getAXState', { ...args, disableDiffing: true }, false, call)
  }

  const pageMethod = (method: string, args: Record<string, unknown>, ctx: ApiSessionContext): Promise<unknown> => {
    const tabId = boundTab(args.tabId).id
    if (BROWSER_ACTION_METHODS.has(method)) panel.showCursor({ kind: cursorKind(method), label: method })
    return execute(tabId, method, { ...args, tabId }, false, pageCall(ctx))
  }

  const historyMethod = async (action: 'back' | 'forward' | 'reload', args: Record<string, unknown>, call: PageCall): Promise<unknown> => {
    const tabId = boundTab(args.tabId).id
    const { ok } = await panel.surface('page.history', { tabId, action }, call)
    if (!ok) throw new RpcError('rejected', 'no-history')
    still(tabId)
    return observeAfterNavigation(tabId, args, call)
  }

  /** An agent's `login` (gated by `cliBrowserPasswordsEnabled`, like `signup`): the one saved
   *  login for the page the driving client shows. The password goes to the
   *  page driver, never back to the caller. */
  const login = async (args: Record<string, unknown>, ctx: ApiSessionContext): Promise<unknown> => {
    const { credential: _credential, ...rest } = args
    const tabId = boundTab(rest.tabId).id
    const call = pageCall(ctx)
    panel.showCursor({ kind: 'type', label: 'login' })
    const { url } = await panel.surface('page.ready', { tabId, nav: panel.tab(tabId).nav }, call)
    still(tabId)
    let host = ''
    try { host = new URL(url).hostname } catch { /* no page */ }
    if (!host) throw new RpcError('rejected', 'browser-login-no-saved-password: the tab shows no web page')
    const saved = deps.passwords.suggestions(url)
    const names = saved.map((entry) => entry.username || '(no username)').join(', ')
    const matching = typeof rest.username === 'string' ? saved.filter((entry) => entry.username === rest.username) : saved
    if (!matching.length) {
      throw new RpcError('rejected', saved.length
        ? `browser-login-no-such-user: the saved logins for ${host} are ${names}`
        : `browser-login-no-saved-password: there is no saved password for ${host}. Ask the person to sign in, or to save the login in the browser panel.`)
    }
    if (matching.length > 1) {
      throw new RpcError('rejected', `browser-login-ambiguous: ${host} has several saved logins (${names}); pick one with --user <name>`)
    }
    const [chosen] = matching
    const fill = deps.passwords.forFill(chosen.id, url)
    if (!fill) throw new RpcError('rejected', `browser-login-no-saved-password: there is no saved password for ${host}`)
    // The driver fills it only while the page still shows `origin`.
    const credential = { username: fill.username, password: fill.password, origin: chosen.origin }
    return execute(tabId, 'login', { ...rest, tabId, credential }, false, call)
  }

  /** An agent's `signup` (gated like `login`): a generated password filled
   *  into the sign-up form of the page the driving client shows, then saved
   *  as the site's login for `username`. The password goes to the page
   *  driver and the store, never back to the caller. */
  const signup = async (args: Record<string, unknown>, ctx: ApiSessionContext): Promise<unknown> => {
    const { credential: _credential, ...rest } = args
    const tabId = boundTab(rest.tabId).id
    const call = pageCall(ctx)
    panel.showCursor({ kind: 'type', label: 'signup' })
    const { url } = await panel.surface('page.ready', { tabId, nav: panel.tab(tabId).nav }, call)
    still(tabId)
    const origin = credentialOrigin(url)
    if (!origin) throw new RpcError('rejected', 'browser-signup-no-page: the tab shows no web page')
    const host = new URL(origin).hostname
    const username = String(rest.username)
    if (deps.passwords.suggestions(url).some((entry) => entry.username === username)) {
      throw new RpcError('rejected', `browser-signup-exists: there is already a saved login for ${host} as ${username}; sign in with cate browser login`)
    }
    const password = generatePassword()
    const result = await execute(tabId, 'signup', { ...rest, tabId, credential: { password, origin } }, false, call)
    await deps.passwords.save({ origin, username, password })
    return result
  }

  const handlers: PageControlHandlers = {
    getAXState: ({ screenshot, ...args }, ctx) => pageMethod(screenshot ? 'getAXStateAndScreenshot' : 'getAXState', args, ctx),
    getScreenshot: (args, ctx) => pageMethod('getScreenshot', args, ctx),
    find: (args, ctx) => pageMethod('find', args, ctx),
    getAttribute: (args, ctx) => pageMethod('getAttribute', args, ctx),
    waitFor: (args, ctx) => pageMethod('waitFor', args, ctx),
    click: (args, ctx) => pageMethod('click', args, ctx),
    hover: (args, ctx) => pageMethod('hover', args, ctx),
    setValue: (args, ctx) => pageMethod('setValue', args, ctx),
    typeText: (args, ctx) => pageMethod('typeText', args, ctx),
    pressKey: (args, ctx) => pageMethod('pressKey', args, ctx),
    scroll: (args, ctx) => pageMethod('scroll', args, ctx),
    drag: (args, ctx) => pageMethod('drag', args, ctx),
    selectText: (args, ctx) => pageMethod('selectText', args, ctx),
    setChecked: (args, ctx) => pageMethod('setChecked', args, ctx),
    selectOption: (args, ctx) => pageMethod('selectOption', args, ctx),
    upload: (args, ctx) => pageMethod('upload', args, ctx),
    dialog: (args, ctx) => pageMethod('dialog', args, ctx),
    console: (args, ctx) => pageMethod('console', args, ctx),
    network: (args, ctx) => pageMethod('network', args, ctx),
    login: (args, ctx) => login(args, ctx),
    signup: (args, ctx) => signup(args, ctx),
    goto: async (args, ctx) => {
      const tabId = boundTab(args.tabId).id
      await panel.navigateTab(tabId, args.url)
      return observeAfterNavigation(tabId, args, pageCall(ctx))
    },
    back: (args, ctx) => historyMethod('back', args, pageCall(ctx)),
    forward: (args, ctx) => historyMethod('forward', args, pageCall(ctx)),
    reload: (args, ctx) => historyMethod('reload', args, pageCall(ctx)),
    download: async (args, ctx) => {
      const tab = boundTab(args.tabId)
      const current = hasPage(tab) ? tab.url : ''
      if (!args.url && !current) throw new RpcError('rejected', 'url-required')
      let url: string
      try {
        url = args.url === undefined ? current : new URL(args.url, current || undefined).href
      } catch {
        throw new RpcError('rejected', 'invalid-browser-url')
      }
      return panel.surface('page.download', { tabId: tab.id, url }, pageCall(ctx))
    },
  }

  return { handlers, boundTab, still, execute, pageInfo }
}
