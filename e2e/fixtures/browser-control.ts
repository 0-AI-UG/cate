// Browser panel helpers for e2e specs. The browser tool is the `cate.browser.*`
// API, called as this client (`api.call` over the workspace connection); page
// oracles run in the guest from main, never through the tool under test.

import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import type { BrowserObservation } from '../../src/services/browser/contract/automation'
import { seedOnCanvas } from './electron-app'

export interface BrowserFixture { workspaceId: string; panelId: string; tabId?: string; nodeId?: string }

export interface InvokeResult { ok: boolean; result?: unknown; error?: string }

/** Creates a browser panel on the active canvas and waits for its guest. */
export async function createBrowser(page: Page, url: string, origin = { x: 120, y: 120 }): Promise<BrowserFixture> {
  const { panelId, nodeId } = await seedOnCanvas(page, 'browser', origin, { url })
  const workspaceId = (await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId()))!
  await expect.poll(() => browserWebContentsId(page, panelId), { timeout: 20_000, message: 'browser guest mounts' }).not.toBeNull()
  // Best effort: the first document finished loading, so early input is not lost.
  await page.waitForFunction((panelId) => {
    const views = [...document.querySelectorAll(`[data-browser-surface="${panelId}"] webview`)] as (HTMLElement & { isLoading(): boolean; getURL(): string })[]
    try { return views.some((v) => v.getURL() !== '' && !v.isLoading()) } catch { return false }
  }, panelId, { timeout: 15_000 }).catch(() => {})
  return { workspaceId, panelId, nodeId }
}

/** The active tab's guest webContents id of a browser panel, or null. */
export async function browserWebContentsId(page: Page, panelId: string): Promise<number | null> {
  return page.evaluate((panelId) => {
    const surface = document.querySelector(`[data-browser-surface="${panelId}"]`)
    const views = [...(surface?.querySelectorAll('webview') ?? [])] as (HTMLElement & { getWebContentsId(): number })[]
    const active = views.find((v) => v.style.display !== 'none') ?? views[0]
    try { return active ? active.getWebContentsId() : null } catch { return null }
  }, panelId)
}

/** One `cate.browser.<method>` call as this client. */
export async function apiInvoke(page: Page, method: string, args: Record<string, unknown>, workspaceId?: string): Promise<InvokeResult> {
  return page.evaluate(async ({ method, args, workspaceId }) => {
    try {
      const result = await window.__cateE2E!.call('api', 'call', { method, args }, workspaceId ?? undefined)
      const failed = result && typeof result === 'object' && (result as { ok?: unknown }).ok === false
      return failed
        ? { ok: false, result, error: String((result as { error?: unknown }).error ?? 'failed') }
        : { ok: true, result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }, { method: `cate.browser.${method}`, args, workspaceId: workspaceId ?? null })
}

/** Pins the tab once, so a popup or user tab switch cannot retarget a binding. */
export async function browserInvoke(page: Page, browser: BrowserFixture, method: string, args: Record<string, unknown> = {}): Promise<InvokeResult> {
  const untargeted = method === 'getTab' || method === 'listTabs' || method === 'createTab'
  if (!browser.tabId && !untargeted) {
    const binding = await browserInvoke(page, browser, 'getTab')
    if (!binding.ok) return binding
    browser.tabId = (binding.result as { tabId: string }).tabId
  }
  const outcome = await apiInvoke(page, method, { panelId: browser.panelId, ...(browser.tabId && !untargeted ? { tabId: browser.tabId } : {}), ...args }, browser.workspaceId)
  if (method === 'getTab' && outcome.ok && !browser.tabId) browser.tabId = (outcome.result as { tabId: string }).tabId
  return outcome
}

export async function observe(page: Page, browser: BrowserFixture, visual = false): Promise<BrowserObservation> {
  const result = await browserInvoke(page, browser, visual ? 'getAXStateAndScreenshot' : 'getAXState', { disableDiffing: true })
  expect(result, `browser observation: ${result.error ?? ''}`).toMatchObject({ ok: true })
  return result.result as BrowserObservation
}

export async function target(page: Page, browser: BrowserFixture, name: string, role?: string) {
  let observation: BrowserObservation
  const matches = (element: BrowserObservation['elements'][number]) => element.name.replace(/\s+/g, ' ').trim() === name && (role ? element.role === role : ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox', 'menuitem', 'tab'].includes(element.role))
  await expect.poll(async () => {
    observation = await observe(page, browser)
    return observation.elements.filter(matches).length
  }, { timeout: 20_000, message: `unique accessible target ${role ?? ''} ${name}` }).toBe(1)
  return { observationId: observation!.observationId, target: observation!.elements.find(matches)!.id }
}

export async function act(page: Page, browser: BrowserFixture, method: string, name: string, args: Record<string, unknown> = {}, role?: string) {
  return browserInvoke(page, browser, method, { ...await target(page, browser, name, role), ...args })
}

export async function activeAction(page: Page, browser: BrowserFixture, method: string, args: Record<string, unknown>) {
  const observation = await observe(page, browser)
  return browserInvoke(page, browser, method, { observationId: observation.observationId, ...args })
}

export async function waitForText(page: Page, browser: BrowserFixture, text: string) {
  return activeAction(page, browser, 'waitFor', { condition: { text }, timeoutMs: 5000 })
}

/** Independent test oracle/setup. Never goes through the public browser tool. */
export async function fixtureEvaluate(app: ElectronApplication, page: Page, browser: BrowserFixture, expression: string) {
  let id: number | null = null
  await expect.poll(async () => {
    id = await browserWebContentsId(page, browser.panelId)
    return id
  }, { timeout: 20_000, message: 'browser fixture guest is mounted' }).not.toBeNull()
  return app.evaluate(({ webContents }, { id, expression }) => webContents.fromId(id!)!.executeJavaScript(expression), { id, expression })
}

export async function inspectFixture(app: ElectronApplication, page: Page, browser: BrowserFixture, expression: string, property = 'value') {
  return { ok: true, result: { [property]: await fixtureEvaluate(app, page, browser, expression) } }
}

export async function popupBinding(page: Page, browser: BrowserFixture, url: string): Promise<BrowserFixture & { tabId: string }> {
  let tabId: string | undefined
  await expect.poll(async () => {
    const result = await browserInvoke(page, browser, 'listTabs')
    const tabs = ((result.result as { tabs?: Array<{ id?: string; tabId?: string; url: string }> } | undefined)?.tabs) ?? []
    const tab = tabs.find((candidate) => candidate.url === url)
    tabId = tab?.tabId ?? tab?.id
    return tabId
  }, { timeout: 20_000 }).toBeTruthy()
  return { ...browser, tabId: tabId! }
}
