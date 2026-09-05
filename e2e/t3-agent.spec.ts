import { test, expect } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeApp, launchApp } from './fixtures/electron-app'

interface AgentSeed {
  workspaceId: string
  panelId: string
  nodeId: string | null
}

const repoRoot = path.resolve(__dirname, '..')
const fakeT3Entry = path.join(repoRoot, 'e2e', 'fixtures', 'fake-t3.cjs')
const fakeProviderLogin = path.join(repoRoot, 'e2e', 'fixtures', 'fake-provider-login.cjs')

let electronApp: ElectronApplication | undefined
let page: Page
let tempRoot: string
let workspaceRoot: string
let agent: AgentSeed

function installFakeProviderCommands(root: string): string {
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const commands = [
    ['codex', 'Codex'],
    ['claude', 'Claude'],
    ['cursor-agent', 'Cursor'],
    ['grok', 'Grok'],
    ['opencode', 'OpenCode'],
  ] as const
  for (const [command, provider] of commands) {
    const launcher = path.join(binDir, command)
    writeFileSync(
      launcher,
      `#!/bin/sh\nCATE_E2E_PROVIDER_NAME=${provider} exec "${process.execPath}" "${fakeProviderLogin}" "$@"\n`,
    )
    chmodSync(launcher, 0o755)
    writeFileSync(
      `${launcher}.cmd`,
      `@echo off\r\nset CATE_E2E_PROVIDER_NAME=${provider}\r\n"${process.execPath}" "${fakeProviderLogin}" %*\r\n`,
    )
  }
  return binDir
}

function agentWebview(): Locator {
  return page.locator(`webview[data-agent-webview="${agent.panelId}"]`)
}

async function guestEval<T>(webview: Locator, source: string): Promise<T> {
  return await webview.evaluate(
    (element, script) => (element as HTMLElement & { executeJavaScript(code: string): Promise<T> })
      .executeJavaScript(script),
    source,
  )
}

async function openAgentSettingsFromGuest(): Promise<void> {
  await guestEval(agentWebview(), `(() => {
    document.querySelector('[data-testid="provider-settings-link"]')?.click()
    return true
  })()`)
  await expect(page.getByRole('heading', { name: 'Provider authentication' })).toBeVisible()
}

test.beforeEach(async ({}, testInfo) => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'cate-t3-agent-e2e-'))
  workspaceRoot = path.join(tempRoot, 'workspace')
  mkdirSync(workspaceRoot)
  const binDir = installFakeProviderCommands(tempRoot)

  const launched = await launchApp({
    userDataDir: path.join(tempRoot, 'userdata'),
    env: {
      CATE_EXTENSIONS_ROOT: path.join(tempRoot, 'extensions'),
      CATE_E2E_PATH_PREPEND: binDir,
      CATE_E2E_UPDATE_UNCHANGED: testInfo.title.includes('Homebrew') ? '1' : '0',
      ...(testInfo.title.startsWith('real T3') ? {} : { CATE_E2E_T3_ENTRY_PATH: fakeT3Entry }),
    },
  })
  electronApp = launched.electronApp
  page = launched.mainWindow

  const opened = page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), workspaceRoot)
  const trust = page.getByRole('button', { name: 'Trust and open' })
  if (await trust.isVisible({ timeout: 2_000 }).catch(() => false)) await trust.click()
  expect(await opened).toBe(true)
  agent = await page.evaluate(() => window.__cateE2E!.createAgent({ x: 24, y: 24 }))
  expect(agent.panelId).toBeTruthy()
  await page.locator(`[data-agent-panel-id="${agent.panelId}"][data-agent-phase="ready"]`).waitFor()
  await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true', { timeout: 30_000 })
})

test.afterEach(async () => {
  if (electronApp) await closeApp(electronApp)
  electronApp = undefined
  rmSync(tempRoot, { recursive: true, force: true })
})

test('real T3 exposes provider settings through the native Cate RPC bridge', async () => {
  await page.evaluate(() => window.__cateE2E!.openSettings('agent'))
  const native = page.locator('[data-agent-native-settings]')
  await expect(native.getByLabel('Display name')).toBeVisible({ timeout: 30_000 })
  await expect(native.getByLabel('Binary path')).toHaveValue('codex')
  await native.getByLabel('Display name').fill('Integration test account')
  await native.getByRole('button', { name: 'Save provider' }).click()
  await expect(native.getByText('Settings saved.', { exact: true })).toBeVisible({ timeout: 30_000 })
  await native.getByRole('button', { name: 'Refresh providers' }).click()
  await expect(native.getByLabel('Display name')).toHaveValue('Integration test account')
  await expect(native.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('webview[data-agent-provider-webview]')).toHaveCount(0)
  await native.getByRole('tab', { name: 'Models', exact: true }).click()
  await expect(native.getByLabel('Custom models (one per line)')).toBeVisible()
  await expect(native.getByLabel('Binary path')).not.toBeVisible()
  await native.getByRole('tab', { name: 'Environment', exact: true }).click()
  await expect(native.getByRole('button', { name: 'Add variable' })).toBeVisible()
  await native.getByRole('tab', { name: 'Configuration', exact: true }).click()
  await page.screenshot({ path: 'output/playwright/agent-settings-redesign.png' })
})

test('boots the authenticated chat surface, removes the embedded sidebar and product chrome', async () => {
  const surface = await guestEval<{
    title: string
    hasT3Logo: boolean
    threadListVisible: boolean
    upstreamHeaderHidden: boolean
    newProjectHidden: boolean
  }>(agentWebview(), `(() => ({
    title: document.title,
    hasT3Logo: Boolean(document.querySelector('svg[aria-label="T3"]')),
    threadListVisible: getComputedStyle(document.querySelector('[data-slot="sidebar"]')).display !== 'none',
    upstreamHeaderHidden: getComputedStyle(document.querySelector('[data-chat-header]')).display === 'none',
    newProjectHidden: getComputedStyle(document.querySelector('button[aria-label="New project"]')).display === 'none',
  }))()`)

  expect(surface).toEqual({
    title: 'T3 Code',
    hasT3Logo: false,
    threadListVisible: false,
    upstreamHeaderHidden: true,
    newProjectHidden: true,
  })
  expect(await guestEval(agentWebview(), `document.querySelector('[data-testid="empty-chat"]')?.textContent`))
    .toContain('Send a message')
})

test('shows every enabled provider in the model picker', async () => {
  const providers = await guestEval<string[]>(agentWebview(), `(() => {
    document.querySelector('#model-picker')?.click()
    return [...document.querySelectorAll('[data-provider]')].map((element) => element.textContent)
  })()`)

  expect(providers).toEqual(['Codex', 'Claude', 'Cursor', 'Grok', 'OpenCode'])
})

test('persists a new chat thread and contains project and settings navigation', async () => {
  await guestEval(agentWebview(), `(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]')
    textarea.value = 'Create the requested change'
    document.querySelector('#composer').requestSubmit()
    return true
  })()`)
  await expect.poll(() => guestEval<string>(agentWebview(), 'location.pathname'))
    .toBe('/e2e-env/thread-e2e')

  await expect.poll(async () => {
    const snapshot = await page.evaluate((panelId) => window.__cateE2E!.agentPanelSnapshot(panelId), agent.panelId)
    return snapshot?.threadId
  }).toBe('thread-e2e')

  const before = await guestEval<string>(agentWebview(), 'location.pathname')
  await guestEval(agentWebview(), `(() => {
    document.querySelector('[data-testid="project-link"]')?.click()
    return true
  })()`)
  await expect.poll(() => guestEval<string>(agentWebview(), 'location.pathname')).toBe(before)

  await openAgentSettingsFromGuest()
  expect(await guestEval<string>(agentWebview(), 'location.pathname')).not.toBe('/settings/providers')
})

test('shows provider connection, version, update, and login state in Cate settings', async () => {
  await openAgentSettingsFromGuest()

  const codex = page.locator('[data-agent-provider="codex"]')
  const claude = page.locator('[data-agent-provider="claude"]')
  const cursor = page.locator('[data-agent-provider="cursor"]')
  const grok = page.locator('[data-agent-provider="grok"]')
  const opencode = page.locator('[data-agent-provider="opencode"]')

  await expect(codex).toHaveAttribute('data-agent-provider-state', 'authenticated', { timeout: 30_000 })
  await expect(codex).toContainText('Connected · ChatGPT Pro test account')
  await expect(codex).toContainText('v0.153.2')
  await expect(page.locator('[data-agent-native-settings]')).toContainText('Update available · v0.153.3')
  await page.getByRole('button', { name: 'Select Claude', exact: true }).click()
  await expect(claude).toHaveAttribute('data-agent-provider-state', 'authenticated')
  await page.getByRole('button', { name: 'Select Cursor', exact: true }).click()
  await expect(cursor).toHaveAttribute('data-agent-provider-state', 'unavailable')
  await page.getByRole('button', { name: 'Select Grok', exact: true }).click()
  await expect(grok).toHaveAttribute('data-agent-provider-state', 'authenticated')
  await page.getByRole('button', { name: 'Select OpenCode', exact: true }).click()
  await expect(opencode).toHaveAttribute('data-agent-provider-state', 'unauthenticated')
  await page.getByRole('button', { name: 'Select Codex', exact: true }).click()

  const native = page.locator('[data-agent-native-settings]')
  await expect(native.getByLabel('Display name')).toBeVisible()
  await expect(page.locator('webview[data-agent-provider-webview]')).toHaveCount(0)
  await native.getByLabel('Display name').fill('Work account')
  await native.getByRole('button', { name: 'Save provider' }).click()
  await expect(native.getByText('Settings saved.', { exact: true })).toBeVisible()
  await native.getByRole('button', { name: 'Refresh providers' }).click()
  await expect(native.getByLabel('Display name')).toHaveValue('Work account')
  await native.getByRole('button', { name: 'Update provider', exact: true }).click()
  await expect(native.getByText('Provider updated.', { exact: true })).toBeVisible()
  await expect(native.getByRole('button', { name: 'Update provider', exact: true })).toHaveCount(0)

})

test('runs every provider sign-in inside settings without creating terminal panels', async () => {
  await openAgentSettingsFromGuest()
  const panelTypesBefore = await page.evaluate(() => window.__cateE2E!.panelTypes())

  const providers = [
    { id: 'codex', name: 'Codex', button: 'Sign in again' },
    { id: 'claude', name: 'Claude', button: 'Sign in again' },
    { id: 'cursor', name: 'Cursor', button: 'Sign in' },
    { id: 'grok', name: 'Grok', button: 'Sign in again' },
    { id: 'opencode', name: 'OpenCode', button: 'Sign in', openCodeProvider: 'openai' },
  ] as const

  for (const provider of providers) {
    await page.getByRole('button', { name: `Select ${provider.name}`, exact: true }).click()
    await page.locator(`[data-agent-provider="${provider.id}"]`)
      .getByRole('button', { name: provider.button, exact: true })
      .click()
    await expect(page.getByText(`Sign in to ${provider.name}`, { exact: true })).toBeVisible()
    if ('openCodeProvider' in provider) {
      await page.locator('#opencode-provider').fill(provider.openCodeProvider)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
    }
    await expect(page.getByText('CATE-1234', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Sign-in completed.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Done', exact: true }).click()
  }

  const panelTypesAfter = await page.evaluate(() => window.__cateE2E!.panelTypes())
  expect(panelTypesAfter).toEqual(panelTypesBefore)
  expect(panelTypesAfter).not.toContain('terminal')
})

test('explains an unchanged Homebrew update once and exposes command output', async () => {
  await openAgentSettingsFromGuest()
  const native = page.locator('[data-agent-native-settings]')
  await native.getByRole('button', { name: 'Update provider', exact: true }).click()
  await expect(native.getByRole('alert')).toContainText('Homebrew finished')
  await expect(native.getByRole('alert')).toHaveCount(1)
  await expect(native.getByRole('status')).toHaveCount(0)
  await native.getByText('Update output', { exact: true }).click()
  await expect(native.getByText('Warning: Not upgrading codex, the latest version is already installed.')).toBeVisible()
  await expect(native).not.toContainText('T3 Code')
})

test('keeps the webview hidden during reload until Cate branding is reapplied', async () => {
  await agentWebview().evaluate((element) => {
    const webview = element as HTMLElement & { getURL(): string; loadURL(url: string): Promise<void> }
    const current = new URL(webview.getURL())
    void webview.loadURL(`${current.origin}/e2e-env/slow-thread`)
  })

  await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'false')
  await expect(agentWebview()).toHaveClass(/invisible/)
  await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true', { timeout: 30_000 })
  await expect(agentWebview()).toHaveClass(/visible/)
  expect(await guestEval(agentWebview(), `({
    title: document.title,
    hasT3Logo: Boolean(document.querySelector('svg[aria-label="T3"]')),
  })`)).toEqual({ title: 'T3 Code', hasT3Logo: false })
  await guestEval(agentWebview(), `(() => {
    const toast = document.createElement('div'); toast.setAttribute('data-sonner-toast', ''); toast.id = 'brand-toast'; toast.textContent = 'T3 Code update failed'; document.body.append(toast);
    const message = document.createElement('p'); message.id = 'user-copy'; message.textContent = 'Explain T3 Code'; document.body.append(message);
  })()`)
  await expect.poll(() => guestEval(agentWebview(), `document.querySelector('#brand-toast').textContent`)).toBe('T3 Code update failed')
  expect(await guestEval(agentWebview(), `document.querySelector('#user-copy').textContent`)).toBe('Explain T3 Code')
})

async function seedConversation(title: string): Promise<void> {
  await guestEval(agentWebview(), `(() => {
    document.querySelector('textarea').value = ${JSON.stringify(title)}
    document.querySelector('#composer').requestSubmit()
  })()`)
  await expect.poll(() => page.evaluate((id) => window.__cateE2E!.agentPanelSnapshot(id)?.threadId, agent.panelId)).toBe('thread-e2e')
  await expect.poll(async () => {
    const state = await guestEval(agentWebview(), 'JSON.stringify(window.__cateT3Threads)')
    return state
  }).toContain(title)
  await expect(page.locator(`[data-tab-panel-id="${agent.panelId}"]`)).toContainText(title)
}

async function guestKey(webview: Locator, key: string, modifiers: string[] = []): Promise<void> {
  const id = await webview.evaluate((element) => (element as HTMLElement & { getWebContentsId(): number }).getWebContentsId())
  await electronApp!.evaluate(({ webContents }, input) => {
    const guest = webContents.fromId(input.id)!
    guest.focus()
    guest.sendInputEvent({ type: 'keyDown', keyCode: input.key, modifiers: input.modifiers as never })
    guest.sendInputEvent({ type: 'keyUp', keyCode: input.key, modifiers: input.modifiers as never })
  }, { id, key, modifiers })
}

async function detachAgent(): Promise<Page> {
  const tab = page.locator(`[data-tab-panel-id="${agent.panelId}"]`)
  const box = (await tab.boundingBox())!
  const width = await page.evaluate(() => innerWidth)
  await page.mouse.move(box.x + 35, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 135, box.y + box.height / 2, { steps: 10 })
  await page.mouse.move(width + 120, box.y + box.height / 2)
  await page.waitForTimeout(300)
  await page.mouse.up()
  let target: Page | undefined
  await expect.poll(async () => {
    for (const candidate of electronApp!.windows()) {
      if (candidate !== page && await candidate.locator(`[data-agent-panel-id="${agent.panelId}"]`).count().catch(() => 0)) target = candidate
    }
    return !!target
  }, { timeout: 20_000 }).toBe(true)
  await expect(target!.locator('webview[data-agent-webview]')).toHaveAttribute('data-agent-guest-ready', 'true')
  return target!
}

test('T3 panel parity: Command+K from a focused guest returns keyboard focus to the chat', async () => {
  await seedConversation('Keyboard focus conversation')
  await guestEval(agentWebview(), `document.querySelector('textarea').focus()`)
  await guestKey(agentWebview(), 'k', [process.platform === 'darwin' ? 'meta' : 'control'])
  const search = page.getByPlaceholder('Search commands, workspaces, panels and files')
  await expect(search).toBeFocused()
  await search.fill('Keyboard focus conversation')
  await search.press('Enter')
  await expect(search).not.toBeVisible()
  await expect.poll(() => guestEval<boolean>(agentWebview(), 'document.hasFocus()')).toBe(true)
  await guestKey(agentWebview(), 'x')
  // insertText goes through the actual focused guest, not a DOM value assignment.
  const id = await agentWebview().evaluate((el) => (el as HTMLElement & { getWebContentsId(): number }).getWebContentsId())
  await electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id)!.insertText('typing after palette'), id)
  expect(await guestEval(agentWebview(), `document.querySelector('textarea').value`)).toContain('typing after palette')
})

test('T3 panel parity: Command+K reveals a detached chat and popup deletion closes its other-window panel', async () => {
  await seedConversation('Detached conversation')
  const detached = await detachAgent()
  await page.bringToFront()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  const search = page.getByPlaceholder('Search commands, workspaces, panels and files')
  await expect(search).toBeVisible()
  await search.fill('Detached conversation')
  await expect(page.getByText('Other window', { exact: true })).toBeVisible()
  await search.press('Enter')
  await expect.poll(() => guestEval<boolean>(detached.locator('webview[data-agent-webview]'), 'document.hasFocus()')).toBe(true)

  await page.bringToFront()
  await page.getByRole('button', { name: 'T3 Code conversations', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'T3 Code conversations' })
  await popup.getByRole('button', { name: 'Delete Detached conversation', exact: true }).click()
  await popup.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Detached conversation', exact: true })).toHaveCount(0)
  await expect.poll(() => detached.isClosed()).toBe(true)
  const remaining = await page.evaluate(({ workspaceId, cwd }) => window.electronAPI.agentHarnessListConversations({ workspaceId, cwd }), { workspaceId: agent.workspaceId, cwd: workspaceRoot })
  expect(remaining).toEqual([])
})
