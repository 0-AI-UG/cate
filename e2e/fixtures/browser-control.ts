import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import type { BrowserObservation } from '../../src/shared/browserAutomation'

export interface BrowserFixture { workspaceId: string; panelId: string; tabId?: string }

/** Pin once, so a popup or user tab switch cannot retarget an existing binding. */
export async function browserInvoke(page: Page, browser: BrowserFixture, method: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!browser.tabId && method !== 'getTab' && method !== 'listTabs') {
    const binding = await browserInvoke(page, browser, 'getTab')
    if (!binding.ok) return binding
    browser.tabId = (binding.result as { tabId: string }).tabId
  }
  const outcome = await page.evaluate(({ browser, method, args }) => window.__cateE2E!.browserInvoke(
    browser.workspaceId, method, { panelId: browser.panelId, ...(browser.tabId ? { tabId: browser.tabId } : {}), ...args },
  ), { browser, method, args })
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
    id = await page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId)
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
    const tabs = (result.result as { tabs: Array<{ id?: string; tabId?: string; url: string }> }).tabs
    const tab = tabs.find((candidate) => candidate.url === url)
    tabId = tab?.tabId ?? tab?.id
    return tabId
  }, { timeout: 20_000 }).toBeTruthy()
  return { ...browser, tabId: tabId! }
}
