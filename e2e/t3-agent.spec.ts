// The chat panel (T3 Code) against the deterministic fake harness
// (`fixtures/fake-t3.cjs`, see T3.md): the runtime starts the harness from its
// install (`fakeT3`), the chat view loads it through the workspace partition,
// and Cate's surface script, thread binding and provider status reach the
// page. Scenarios that need the real, patched T3 server (the old "real T3"
// suite) need the runtime tarball's harness and are not ported here.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { closeApp, launchApp, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let home: string
let chat: { panelId: string; nodeId: string }

const guest = (): Locator => page.locator(`webview[data-chat-webview="${chat.panelId}"]`)
const guestEval = <T>(source: string): Promise<T> =>
  guest().evaluate((element, script) => (element as HTMLElement & { executeJavaScript(code: string): Promise<T> }).executeJavaScript(script), source)
const guestPath = () => guest().evaluate((element) => new URL((element as HTMLElement & { getURL(): string }).getURL()).pathname)
const snapshot = () => page.evaluate((id) => window.__cateE2E!.sessionSnapshot(id), chat.panelId) as Promise<{ threadId: string | null; phase: string } | null>

test.beforeEach(async () => {
  home = makeHome()
  ;({ electronApp: app, mainWindow: page } = await launchApp({ home, workspace: makeProject(home, { git: true }), fakeT3: true }))
  chat = await seedOnCanvas(page, 'chat', { x: 24, y: 24 })
  await expect(guest()).toHaveAttribute('data-chat-guest-ready', 'true', { timeout: 45_000 })
})
test.afterEach(async () => closeApp(app, { home }))

test('boots the authenticated chat surface through the workspace partition', async () => {
  expect(await guest().evaluate((el) => (el as HTMLElement & { getURL(): string }).getURL())).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
  expect(await guestEval<string>('document.title')).toBe('T3 Code')
  expect(await guestEval<string>(`document.querySelector('[data-testid="empty-chat"]')?.textContent ?? ''`)).toContain('Send a message')
  await expect.poll(async () => (await snapshot())?.phase).toBe('ready')
})

test('a message creates a thread the chat panel binds to', async () => {
  await guestEval(`(() => {
    document.querySelector('textarea[aria-label="Message"]').value = 'Create the requested change'
    document.querySelector('#composer').requestSubmit()
    return true
  })()`)
  await expect.poll(() => guestPath()).toBe('/e2e-env/thread-e2e')
  await expect.poll(async () => (await snapshot())?.threadId, { timeout: 15_000 }).toBe('thread-e2e')
})

test('the guest survives moving its node on the canvas', async () => {
  await guestEval(`(() => { window.__survival = 'same guest'; return true })()`)
  await page.evaluate((id) => window.__cateE2E!.moveNode(id, { x: 400, y: 300 }), chat.nodeId)
  await page.waitForTimeout(300)
  expect(await guestEval<string>('window.__survival')).toBe('same guest')
})

test('the guest survives switching to another workspace and back', async () => {
  await guestEval(`(() => { window.__survival = 'same guest'; return true })()`)

  const first = await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())
  const other = makeProject(home, { name: 'other' })
  const { openWorkspace } = await import('./fixtures/electron-app')
  await openWorkspace(page, other)
  await page.evaluate((id) => window.__cateE2E!.selectWorkspace(id!), first)
  await expect(guest()).toHaveAttribute('data-chat-guest-ready', 'true', { timeout: 15_000 })
  expect(await guestEval<string>('window.__survival')).toBe('same guest')
})

test('provider status from the harness shows in Cate settings', async () => {
  await page.evaluate(() => window.__cateE2E!.openSettings('t3-code'))
  const codex = page.locator('[data-agent-provider="codex"]')
  await expect(codex).toHaveAttribute('data-agent-provider-state', 'authenticated', { timeout: 30_000 })
  await expect(codex).toContainText('Connected · ChatGPT Pro test account')
  await expect(codex).toContainText('v0.153.2')
})
