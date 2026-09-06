import { test, expect } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
let launchOptions: Parameters<typeof launchApp>[0]

function installFakeProviderCommands(root: string, realChat = false): string {
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
    const entry = realChat && command === 'codex' ? path.join(repoRoot, 'e2e', 'fixtures', 'fake-codex-app-server.cjs') : fakeProviderLogin
    writeFileSync(
      launcher,
      `#!/bin/sh\nCATE_E2E_PROVIDER_NAME=${provider} exec "${process.execPath}" "${entry}" "$@"\n`,
    )
    chmodSync(launcher, 0o755)
    writeFileSync(
      `${launcher}.cmd`,
      `@echo off\r\nset CATE_E2E_PROVIDER_NAME=${provider}\r\n"${process.execPath}" "${entry}" %*\r\n`,
    )
  }
  return binDir
}

function agentWebview(): Locator {
  return page.locator(`webview[data-agent-webview="${agent.panelId}"]`)
}

async function guestPath(): Promise<string> {
  // Route polling must not queue JavaScript in a guest being replaced. Electron
  // exposes the committed URL synchronously even while the document is loading.
  return agentWebview().evaluate(element => new URL((element as HTMLElement & { getURL(): string }).getURL()).pathname)
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
  await expect(page.getByRole('heading', { name: 'Codex account' })).toBeVisible()
}

// Playwright requires object destructuring even when no fixtures are used.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, testInfo) => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'cate-t3-agent-e2e-'))
  workspaceRoot = path.join(tempRoot, 'workspace')
  mkdirSync(workspaceRoot)
  const binDir = installFakeProviderCommands(tempRoot, testInfo.title.startsWith('real T3 lifecycle'))
  if (testInfo.title.startsWith('real T3 lifecycle')) {
    const harnessRoot = path.join(tempRoot, 'harness')
    mkdirSync(harnessRoot, { recursive: true })
    const homePath = path.join(tempRoot, 'codex-home')
    mkdirSync(homePath)
    const config = { enabled: true, binaryPath: path.join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex'), homePath, launchArgs: '', customModels: ['gpt-5.4'] }
    writeFileSync(path.join(harnessRoot, 'provider-profile.json'), JSON.stringify({
      providers: { codex: config, claudeAgent: { enabled: false }, cursor: { enabled: false }, grok: { enabled: false }, opencode: { enabled: false } },
      providerInstances: { codex: { driver: 'codex', enabled: true, config, environment: [{ name: 'CATE_E2E_CODEX_STATE', value: path.join(tempRoot, 'codex-state.json'), sensitive: false }] } },
      enableProviderUpdateChecks: false,
    }))
  }


  launchOptions = {
    userDataDir: path.join(tempRoot, 'userdata'),
    env: {
      CATE_HARNESS_ROOT: path.join(tempRoot, 'harness'),
      CATE_E2E_PATH_PREPEND: binDir,
      CATE_E2E_CODEX_STATE: path.join(tempRoot, 'codex-state.json'),
      CATE_E2E_UPDATE_UNCHANGED: testInfo.title.includes('Homebrew') ? '1' : '0',
      ...(testInfo.title.startsWith('real T3') ? {} : { CATE_E2E_T3_ENTRY_PATH: fakeT3Entry }),
    },
  }
  const launched = await launchApp(launchOptions)
  electronApp = launched.electronApp
  page = launched.mainWindow

  const opened = page.evaluate((root) => window.__cateE2E!.setWorkspaceRoot(root), workspaceRoot)
  const trust = page.getByRole('button', { name: 'Trust and open' })
  if (await trust.isVisible({ timeout: 2_000 }).catch(() => false)) await trust.click()
  expect(await opened).toBe(true)
  agent = await page.evaluate((docked) => docked
    ? window.__cateE2E!.createAgent(undefined, { target: 'dock', zone: 'center' })
    : window.__cateE2E!.createAgent({ x: 24, y: 24 }), testInfo.title.startsWith('docked T3'))
  expect(agent.panelId).toBeTruthy()
  await page.locator(`[data-agent-panel-id="${agent.panelId}"][data-agent-phase="ready"]`).waitFor()
  await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true', { timeout: 30_000 })
  if (testInfo.title.startsWith('real T3 lifecycle')) {
    const config = await page.evaluate(({ workspaceId, cwd }) => window.electronAPI.agentProviderSettings({ workspaceId, cwd, operation: 'read' }), { workspaceId: agent.workspaceId, cwd: workspaceRoot })
    if ('error' in config) throw new Error(config.error)
    expect(config.settings.providers.codex.binaryPath).toBe(path.join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex'))
    expect(config.settings.providerInstances.codex.config.binaryPath).toBe(config.settings.providers.codex.binaryPath)
  }
})

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const requests = path.join(tempRoot, 'codex-state.json.requests')
    if (existsSync(requests)) await testInfo.attach('provider-protocol', { path: requests, contentType: 'application/x-ndjson' })
    const body = page && !page.isClosed() ? await guestEval<string>(agentWebview(), 'document.body.innerText').catch(() => '') : ''
    await testInfo.attach('guest-text', { body, contentType: 'text/plain' })
  }
  if (electronApp) await closeApp(electronApp)
  electronApp = undefined
  rmSync(tempRoot, { recursive: true, force: true })
})

test('real T3 exposes provider settings through the native Cate RPC bridge', async () => {
  await page.evaluate(() => window.__cateE2E!.openSettings('agent'))
  const native = page.locator('[data-agent-native-settings]')
  await expect(native.getByLabel('Display name')).toBeHidden()
  await expect(native.getByRole('button', { name: 'Configure Codex', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: test.info().outputPath('agent-settings-collapsed.png') })
  await native.locator('summary').filter({ hasText: 'Advanced provider settings' }).click()
  await expect(native.getByLabel('Display name')).toBeVisible({ timeout: 30_000 })
  await expect(native.getByLabel('Binary path')).toHaveValue('codex')
  await native.getByLabel('Display name').fill('Integration test account')
  await native.getByLabel('Launch arguments').fill('--config\nmodel_reasoning_effort="low"')
  await native.getByRole('button', { name: 'Save provider' }).click()
  await expect(native.getByText('Settings saved.', { exact: true })).toBeVisible({ timeout: 30_000 })
  await native.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(native.getByLabel('Display name')).toHaveValue('Integration test account')
  await expect(native.getByLabel('Launch arguments')).toHaveValue('--config\nmodel_reasoning_effort="low"')
  await expect(native.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('webview[data-agent-provider-webview]')).toHaveCount(0)
  await expect(native.getByLabel('Custom models', { exact: true })).toBeVisible()
  await expect(native.getByRole('button', { name: 'Add variable' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('agent-settings.png') })
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

  expect(providers).toEqual(['Codex', 'Claude', 'Cursor', 'OpenCode'])
})

test('persists a new chat thread and contains project and settings navigation', async () => {
  await guestEval(agentWebview(), `(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]')
    textarea.value = 'Create the requested change'
    document.querySelector('#composer').requestSubmit()
    return true
  })()`)
  await expect.poll(() => guestPath())
    .toBe('/e2e-env/thread-e2e')

  await expect.poll(async () => {
    const snapshot = await page.evaluate((panelId) => window.__cateE2E!.agentPanelSnapshot(panelId), agent.panelId)
    return snapshot?.threadId
  }).toBe('thread-e2e')

  const before = await guestPath()
  await guestEval(agentWebview(), `(() => {
    document.querySelector('[data-testid="project-link"]')?.click()
    return true
  })()`)
  await expect.poll(() => guestPath()).toBe(before)

  await openAgentSettingsFromGuest()
  expect(await guestPath()).not.toBe('/settings/providers')
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
  await expect(page.getByRole('button', { name: 'Update provider', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Configure Claude Code', exact: true }).click()
  await expect(claude).toHaveAttribute('data-agent-provider-state', 'authenticated')
  await page.getByRole('button', { name: 'Configure Cursor', exact: true }).click()
  await expect(cursor).toHaveAttribute('data-agent-provider-state', 'unavailable')
  await page.getByRole('button', { name: 'Configure Grok', exact: true }).click()
  await expect(grok).toHaveAttribute('data-agent-provider-state', 'disabled')
  await page.getByRole('button', { name: 'Configure OpenCode', exact: true }).click()
  await expect(opencode).toHaveAttribute('data-agent-provider-state', 'unauthenticated')
  await page.getByRole('button', { name: 'Configure Codex', exact: true }).click()

  const native = page.locator('[data-agent-native-settings]')
  await expect(native.getByLabel('Display name')).toBeHidden()
  await native.locator('summary').filter({ hasText: 'Advanced provider settings' }).click()
  await expect(native.getByLabel('Display name')).toBeVisible()
  await expect(page.locator('webview[data-agent-provider-webview]')).toHaveCount(0)
  await native.getByLabel('Display name').fill('Work account')
  await native.getByRole('button', { name: 'Save provider' }).click()
  await expect(native.getByText('Settings saved.', { exact: true })).toBeVisible()
  await native.getByRole('button', { name: 'Refresh', exact: true }).click()
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
    { id: 'claude', name: 'Claude Code', button: 'Sign in again' },
    { id: 'cursor', name: 'Cursor', button: 'Sign in' },
    { id: 'grok', name: 'Grok', button: 'Sign in' },
    { id: 'opencode', name: 'OpenCode', button: 'Sign in', openCodeProvider: 'openai' },
  ] as const

  for (const provider of providers) {
    await page.getByRole('button', { name: `Configure ${provider.name}`, exact: true }).click()
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

test('explains an unchanged Homebrew update once without claiming success', async () => {
  await openAgentSettingsFromGuest()
  const native = page.locator('[data-agent-native-settings]')
  await native.getByRole('button', { name: 'Update provider', exact: true }).click()
  await expect(native.getByRole('alert')).toContainText('Homebrew finished')
  await expect(native.getByRole('alert')).toHaveCount(1)
  await expect(native.getByRole('status')).toHaveCount(0)
  await expect(native.getByRole('alert')).toContainText('0.153.2')
  await expect(native.getByRole('button', { name: 'Update provider', exact: true })).toBeVisible()
})

test('real T3 follows Cate theme changes without reloading the conversation', async () => {
  await expect.poll(() => guestEval(agentWebview(), `Boolean(document.querySelector('[contenteditable=true]'))`)).toBe(true)
  await guestEval(agentWebview(), `(() => {
    window.__themeSurvival = 'same guest';
    document.querySelector('[contenteditable=true]').focus();
  })()`)
  const guestId = await agentWebview().evaluate(element => (element as HTMLElement & { getWebContentsId(): number }).getWebContentsId())
  await electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id)!.insertText('Draft through theme changes'), guestId)
  await expect.poll(() => guestEval(agentWebview(), `document.querySelector('[contenteditable=true]').textContent`)).toBe('Draft through theme changes')
  for (const id of ['dark-cold', 'light-subtle', 'dracula']) {
    const expected = await page.evaluate((themeId) => {
      window.__cateE2E!.setTheme(themeId)
      const root = document.documentElement
      return {
        background: root.style.getPropertyValue('--surface-4'),
        foreground: root.style.getPropertyValue('--text-primary'),
        primary: root.style.getPropertyValue('--focus-blue'),
        mode: root.dataset.theme,
      }
    }, id)
    await expect.poll(() => guestEval(agentWebview(), `(() => {
      const css = getComputedStyle(document.documentElement);
      return { background: css.getPropertyValue('--background').trim(), foreground: css.getPropertyValue('--foreground').trim(),
        primary: css.getPropertyValue('--primary').trim(), mode: css.colorScheme };
    })()`)).toEqual(expected)
    expect(await guestEval(agentWebview(), `({ marker: window.__themeSurvival, draft: document.querySelector('[contenteditable=true]').textContent })`))
      .toEqual({ marker: 'same guest', draft: 'Draft through theme changes' })
    await guestEval(agentWebview(), `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
    // Buttons animate their color; wait for the theme transition before QA.
    await expect.poll(() => guestEval(agentWebview(), `(() => {
      const button = document.querySelector('button[aria-label="Change project"]');
      return getComputedStyle(button).color === getComputedStyle(document.querySelector('h1')).color;
    })()`)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`t3-theme-${id}.png`) })
  }
})

test('docked T3 hides when switching to its sibling canvas tab and preserves the conversation', async () => {
  expect(agent.nodeId).toBeNull()
  const agentTab = page.locator(`[data-tab-panel-id="${agent.panelId}"]`)
  const canvasTab = page.locator('[data-tab-panel-id]').filter({ hasText: 'Canvas' })
  const canvasId = await canvasTab.getAttribute('data-tab-panel-id')
  const stackId = (tab: Locator) => tab.evaluate(element => element.closest('[data-dock-stack-id]')?.getAttribute('data-dock-stack-id'))
  expect(await stackId(agentTab)).toBe(await stackId(canvasTab))
  await guestEval(agentWebview(), `(() => {
    window.__tabSurvival = 'same conversation';
    document.querySelector('textarea').value = 'Unsent dock draft';
  })()`)
  const guestId = await agentWebview().evaluate(element => (element as HTMLElement & { getWebContentsId(): number }).getWebContentsId())

  for (let i = 0; i < 2; i++) {
    await canvasTab.click()
    await expect(page.locator(`[data-canvas-panel-id="${canvasId}"]`)).toBeVisible()
    await expect(agentWebview()).toBeAttached()
    await expect(agentWebview()).toBeHidden()
    await expect(agentWebview()).toHaveCSS('visibility', 'hidden')

    await agentTab.click()
    await expect(agentWebview()).toBeVisible()
    await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true')
    expect(await agentWebview().evaluate(element => (element as HTMLElement & { getWebContentsId(): number }).getWebContentsId())).toBe(guestId)
    expect(await guestEval(agentWebview(), `({ marker: window.__tabSurvival, draft: document.querySelector('textarea').value })`))
      .toEqual({ marker: 'same conversation', draft: 'Unsent dock draft' })
  }
})

test('preserves the T3 guest and unsent draft across canvas focus changes', async () => {
  await guestEval(agentWebview(), `(() => {
    window.__focusSurvival = 'still here';
    document.querySelector('textarea').value = 'Unsent draft';
  })()`)
  const otherNodeId = await page.evaluate(() => window.__cateE2E!.createEditor({ x: 700, y: 24 }))
  await agentWebview().evaluate((element) => {
    element.setAttribute('data-test-navigations', '0')
    element.addEventListener('did-start-navigation', () => {
      element.setAttribute('data-test-navigations', String(Number(element.getAttribute('data-test-navigations')) + 1))
    })
  })
  for (const nodeId of [agent.nodeId!, otherNodeId, agent.nodeId!, otherNodeId, agent.nodeId!]) {
    // Exercise the same focus/bring-to-front handler as a click on the dim layer.
    await page.locator(`[data-node-id="${nodeId}"] [data-unfocused-overlay]`).dispatchEvent('click', { button: 0 })
    await expect(page.locator(`[data-node-id="${nodeId}"]`)).toHaveAttribute('data-node-active', 'true')
    await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true')
    expect(await guestEval(agentWebview(), `({ marker: window.__focusSurvival, draft: document.querySelector('textarea').value })`))
      .toEqual({ marker: 'still here', draft: 'Unsent draft' })
    await expect(agentWebview()).toHaveAttribute('data-test-navigations', '0')
  }
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
  await expect(agentWebview()).toBeVisible()
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

// Exercise the native menu's real click callback without OS menu automation.
// Only the one popup is intercepted; the renderer, IPC, and chat loading run normally.
async function selectOverlay(label: string) {
  await page.locator(`[data-tab-panel-id="${agent.panelId}"]`).click()
  await electronApp!.evaluate(({ Menu }, label) => {
    const original = Menu.prototype.popup
    Menu.prototype.popup = function (options) {
      Menu.prototype.popup = original
      const item = this.items.find((item) => item.label === label)
      if (!item) throw new Error(`Missing menu item: ${label}`)
      item.click(undefined as never, undefined as never, undefined as never)
      options?.callback?.()
    }
  }, label)
  await page.getByRole('button', { name: 'Select chat', exact: true }).click()
}

for (const entry of ['overlay', 'action bar'] as const) {
  test(`real T3 new conversation from ${entry} stays in a fresh draft with an existing chat`, async () => {
    // Use the actual bundled T3 router/bootstrap, not fake-t3: the fake never
    // emitted the welcome redirect that caused this regression.
    const seed = await guestEval<{ ok: boolean; body: string }>(agentWebview(), `(async () => {
      const shell = await (await fetch('/api/orchestration/shell')).json()
      const project = shell.projects[0]
      const response = await fetch('/api/orchestration/dispatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'thread.create', commandId: crypto.randomUUID(),
          threadId: 'saved-chat', projectId: project.id, title: 'Existing regression chat',
          modelSelection: project.defaultModelSelection ?? { instanceId: 'codex', model: 'gpt-5' },
          runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
          createdAt: new Date().toISOString() })
      })
      return { ok: response.ok, body: await response.text() }
    })()`)
    expect(seed.ok, seed.body).toBe(true)

    await selectOverlay('Existing regression chat')
    await expect.poll(() => page.evaluate((id) => window.__cateE2E!.agentPanelSnapshot(id)?.threadId, agent.panelId)).toBe('saved-chat')
    // Switching remounts the guest asynchronously; poll through its detached/loading phase.
    await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true')
    await expect.poll(() => guestPath().catch(() => '')).toMatch(/\/saved-chat$/)

    const originalPanelId = agent.panelId
    if (entry === 'overlay') {
      await selectOverlay('New conversation')
    } else {
      await page.getByRole('button', { name: 'T3 Code conversations', exact: true }).click()
      await page.getByRole('dialog', { name: 'T3 Code conversations' }).getByRole('button', { name: 'New conversation', exact: true }).click()
      await page.getByRole('button', { name: 'Create new agent at position 1', exact: true }).click()
      const fresh = page.locator(`webview[data-agent-webview]:not([data-agent-webview="${originalPanelId}"])`)
      await expect(fresh).toHaveCount(1)
      agent = { ...agent, panelId: (await fresh.getAttribute('data-agent-webview'))! }
    }
    await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true')
    // T3 can keep a fresh composer at / until allocating a draft route.
    // Both are unbound; a saved conversation route must never return here.
    await expect.poll(() => guestPath().catch(() => ''), { timeout: 30_000 }).toMatch(/^(?:\/|\/draft\/[^/]+)$/)
    // Reload the fresh guest too: a delayed welcome/bootstrap must not restore
    // the saved chat after the empty composer briefly appears.
    await agentWebview().evaluate((element) => new Promise<void>((resolve) => {
      element.addEventListener('did-finish-load', () => resolve(), { once: true })
      ;(element as HTMLElement & { reload(): void }).reload()
    }))
    await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true')
    await expect.poll(() => guestPath().catch(() => '')).toMatch(/^(?:\/|\/draft\/[^/]+)$/)
    await expect.poll(() => guestEval<number>(agentWebview(), 'document.querySelectorAll("[contenteditable=true]").length')).toBeGreaterThan(0)
    expect(await page.evaluate((id) => window.__cateE2E!.agentPanelSnapshot(id)?.threadId, agent.panelId)).toBeFalsy()
    const conversations = await page.evaluate(({ workspaceId, cwd }) => window.electronAPI.agentHarnessListConversations({ workspaceId, cwd }), { workspaceId: agent.workspaceId, cwd: workspaceRoot })
    expect(conversations).toEqual([expect.objectContaining({ id: 'saved-chat', title: 'Existing regression chat' })])
    if (entry === 'action bar') {
      expect(await page.evaluate((id) => window.__cateE2E!.agentPanelSnapshot(id)?.threadId, originalPanelId)).toBe('saved-chat')
    }
  })
}


async function submitRealChat(text: string): Promise<void> {
  await expect.poll(() => guestEval<number>(agentWebview(), 'document.querySelectorAll("[contenteditable=true]").length').catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(0)
  await guestEval(agentWebview(), `document.querySelector('[contenteditable=true]').focus()`)
  const id = await agentWebview().evaluate((element) => (element as HTMLElement & { getWebContentsId(): number }).getWebContentsId())
  await electronApp!.evaluate(({ webContents }, { id, text }) => webContents.fromId(id)!.insertText(text), { id, text })
  await guestKey(agentWebview(), 'Enter')
}
async function realThreadState() {
  return await guestEval<{ id: string; latestTurn?: { state: string }; hasPendingApprovals?: boolean; session?: { status: string } } | null>(agentWebview(), `(async () => {
    const id = location.pathname.split('/')[2]
    const shell = await (await fetch('/api/orchestration/shell')).json()
    return shell.threads.find(thread => thread.id === id) ?? null
  })()`)
}
async function waitForRealReply(text: string) {
  await expect.poll(() => guestEval<string>(agentWebview(), 'document.body.innerText').catch(() => ''), { timeout: 30_000 }).toContain('Fixture streaming reply: ' + text)
  await expect.poll(async () => (await realThreadState())?.latestTurn?.state).toBe('completed')
}

test('real T3 lifecycle sends, streams, switches chats, restarts Cate and resumes the same provider thread', async () => {
  // T3 buffers messages by default. Explicitly exercise its streaming mode.
  const settings = await page.evaluate(({ workspaceId, cwd }) => window.electronAPI.agentProviderSettings({ workspaceId, cwd, operation: 'save', patch: { enableLegacyTokenStreaming: true } }), { workspaceId: agent.workspaceId, cwd: workspaceRoot })
  if ('error' in settings) throw new Error(settings.error)
  expect(settings.settings.enableLegacyTokenStreaming).toBe(true)
  const firstMessage = 'fixture:stream first lifecycle message'
  await submitRealChat(firstMessage)
  await expect.poll(() => guestEval<string>(agentWebview(), 'document.body.innerText').catch(() => ''), { timeout: 30_000 }).toContain('Fixture streaming')
  expect(await guestEval<string>(agentWebview(), 'document.body.innerText')).not.toContain('Fixture streaming reply:')
  expect((await realThreadState())?.latestTurn?.state).toBe('running')
  writeFileSync(path.join(tempRoot, 'codex-state.json.release-stream'), '')
  await waitForRealReply(firstMessage)
  const firstThread = (await realThreadState())!.id
  await expect.poll(() => page.evaluate((id) => window.__cateE2E!.agentPanelSnapshot(id)?.threadId, agent.panelId)).toBe(firstThread)
  await selectOverlay('New conversation')
  await expect.poll(() => guestPath().catch(() => '')).toMatch(/^\/draft\//)
  await submitRealChat('second lifecycle message')
  await waitForRealReply('second lifecycle message')
  const secondThread = (await realThreadState())!.id
  expect(secondThread).not.toBe(firstThread)
  const conversations = await page.evaluate(({ workspaceId, cwd }) => window.electronAPI.agentHarnessListConversations({ workspaceId, cwd }), { workspaceId: agent.workspaceId, cwd: workspaceRoot })
  if ('error' in conversations) throw new Error(conversations.error)
  await selectOverlay(conversations.find(thread => thread.id === firstThread)!.title)
  await waitForRealReply(firstMessage)
  expect(await guestEval<string>(agentWebview(), 'document.body.innerText')).not.toContain('second lifecycle message')

  await closeApp(electronApp!)
  electronApp = undefined
  const relaunched = await launchApp(launchOptions)
  electronApp = relaunched.electronApp
  page = relaunched.mainWindow
  await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true', { timeout: 30_000 })
  await waitForRealReply(firstMessage)
  expect((await realThreadState())!.id).toBe(firstThread)
  await submitRealChat('resumed lifecycle message')
  await waitForRealReply('resumed lifecycle message')
  expect((await realThreadState())!.id).toBe(firstThread)
  const requests = readFileSync(path.join(tempRoot, 'codex-state.json.requests'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const firstTurn = requests.find(request => request.method === 'turn/start' && request.params.input.some((item: { text?: string }) => item.text === firstMessage))
  expect(firstTurn).toBeDefined()
  expect(requests.filter(request => request.method === 'thread/resume').map(request => request.params.threadId)).toContain(firstTurn.params.threadId)
})


async function clickGuestButton(label: string) {
  await expect.poll(() => guestEval<number>(agentWebview(), `Array.from(document.querySelectorAll('button')).filter(button => (button.getAttribute('aria-label') || button.textContent.trim()) === ${JSON.stringify(label)} && !button.disabled).length`)).toBe(1)
  await guestEval(agentWebview(), `Array.from(document.querySelectorAll('button')).find(button => (button.getAttribute('aria-label') || button.textContent.trim()) === ${JSON.stringify(label)}).click()`)
}

for (const decision of ['Approve', 'Decline'] as const) {
  test(`real T3 lifecycle ${decision.toLowerCase()} reaches the provider and clears the pending approval`, async () => {
    await submitRealChat('fixture:approval')
    await expect.poll(async () => (await realThreadState())?.hasPendingApprovals, { timeout: 30_000 }).toBe(true)
    await clickGuestButton(decision)
    await expect.poll(async () => (await realThreadState())?.latestTurn?.state).toBe('completed')
    await expect.poll(() => guestEval<string>(agentWebview(), 'document.body.innerText')).toContain(decision === 'Approve' ? 'Approved fixture command' : 'Declined fixture command')
    expect((await realThreadState())?.hasPendingApprovals).toBe(false)
    const requests = readFileSync(path.join(tempRoot, 'codex-state.json.requests'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(requests.some(request => request.result?.decision === (decision === 'Approve' ? 'accept' : 'decline'))).toBe(true)
  })
}

test('real T3 lifecycle cancels a running turn and accepts the next message', async () => {
  await submitRealChat('fixture:cancel')
  await expect.poll(async () => (await realThreadState())?.latestTurn?.state, { timeout: 30_000 }).toBe('running')
  await clickGuestButton('Stop generation')
  await expect.poll(async () => (await realThreadState())?.latestTurn?.state).toBe('interrupted')
  await submitRealChat('after cancellation')
  await waitForRealReply('after cancellation')
})

test('real T3 lifecycle recovers after the provider process exits unexpectedly', async () => {
  await submitRealChat('fixture:crash')
  await expect.poll(async () => (await realThreadState())?.session?.status, { timeout: 30_000 }).toBe('stopped')
  const threadId = (await realThreadState())!.id
  await submitRealChat('after provider crash')
  await waitForRealReply('after provider crash')
  expect((await realThreadState())!.id).toBe(threadId)
})

async function restartCate() {
  await closeApp(electronApp!)
  electronApp = undefined
  const launched = await launchApp(launchOptions)
  electronApp = launched.electronApp
  page = launched.mainWindow
  await expect(agentWebview()).toHaveAttribute('data-agent-guest-ready', 'true', { timeout: 30_000 })
}

async function openNativeProviderSettings() {
  await page.evaluate(() => window.__cateE2E!.openSettings('agent'))
  const native = page.locator('[data-agent-native-settings]')
  await native.locator('summary').filter({ hasText: 'Advanced provider settings' }).click()
  await expect(native.getByLabel('Display name')).toBeVisible()
  return native
}

async function saveProvider(native: Locator) {
  await native.getByRole('button', { name: 'Save provider', exact: true }).click()
  await expect(native.getByRole('status')).toHaveText('Settings saved.')
  await expect(native.getByRole('alert')).toHaveCount(0)
}

async function assertChatTitle(title: string) {
  await expect(page.locator(`[data-tab-panel-id="${agent.panelId}"]`)).toContainText(title, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Select chat', exact: true })).toHaveAttribute('title', `Chat: ${title}`)
  await page.getByRole('button', { name: 'T3 Code conversations', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'T3 Code conversations' })
  await expect(popup.getByTitle(title, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  // Exact native-menu label includes the selected check mark.
  await selectOverlay(title + '  ✓')
}

test('real T3 lifecycle extracts generated titles, propagates regeneration and restores titles after restart', async () => {
  await submitRealChat('Please repair the unusual sidebar scrolling behavior')
  await waitForRealReply('Please repair the unusual sidebar scrolling behavior')
  await assertChatTitle('Generated Conversation Title')
  const threadId = (await realThreadState())!.id
  const result = await guestEval<{ ok: boolean; body: string }>(agentWebview(), `(async () => {
    const response = await fetch('/api/orchestration/dispatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'thread.meta.update', commandId: crypto.randomUUID(), threadId: ${JSON.stringify(threadId)}, regenerateTitle: true })
    })
    return { ok: response.ok, body: await response.text() }
  })()`)
  expect(result.ok, result.body).toBe(true)
  await assertChatTitle('Refined Conversation Title')
  await restartCate()
  await assertChatTitle('Refined Conversation Title')
  expect((await realThreadState())!.id).toBe(threadId)
  const requests = readFileSync(path.join(tempRoot, 'codex-state.json.requests'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const titles = requests.filter(request => request.method === 'fixture/title')
  expect(titles.length).toBeGreaterThanOrEqual(2)
  expect(titles[0].prompt).toContain('Please repair the unusual sidebar scrolling behavior')
  expect(titles.at(-1).prompt).toContain('Generated Conversation Title')
})

test('real T3 lifecycle settings persist custom models and secrets and apply CLI configuration after restart', async () => {
  let native = await openNativeProviderSettings()
  await native.getByLabel('Display name').fill('Isolated test account')
  await native.getByLabel('Accent color').fill('#123456')
  await native.getByLabel('Launch arguments').fill('--config\nfixture_setting="test-value"')
  await native.getByLabel('Custom models', { exact: true }).fill('gpt-5.4\nfixture-custom-model\n\n')
  // Variable 1 is the isolated protocol-state path supplied by setup.
  await native.getByRole('button', { name: 'Add variable', exact: true }).click()
  await native.getByLabel('Variable name 2', { exact: true }).fill('CATE_E2E_MARKER')
  await native.getByLabel('Variable value 2', { exact: true }).fill('ordinary-fixture-value')
  await native.getByRole('switch', { name: 'Secret 2', exact: true }).click()
  await native.getByRole('button', { name: 'Add variable', exact: true }).click()
  await native.getByLabel('Variable name 3', { exact: true }).fill('CATE_E2E_SECRET')
  await native.getByLabel('Variable value 3', { exact: true }).fill('synthetic-fixture-secret')
  await saveProvider(native)
  await native.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(native.getByLabel('Variable value 3', { exact: true })).toHaveValue('')
  await expect(native.getByLabel('Variable value 3', { exact: true })).toHaveAttribute('placeholder', 'Stored securely')
  // Saving another field must preserve an unchanged redacted secret.
  await native.getByLabel('Display name').fill('Persisted test account')
  await saveProvider(native)
  await restartCate()
  native = await openNativeProviderSettings()
  await expect(native.getByLabel('Display name')).toHaveValue('Persisted test account')
  await expect(native.getByLabel('Accent color')).toHaveValue('#123456')
  await expect(native.getByLabel('Custom models', { exact: true })).toHaveValue('gpt-5.4\nfixture-custom-model')
  await expect(native.getByLabel('Launch arguments')).toHaveValue('--config\nfixture_setting="test-value"')
  await expect(native.getByLabel('Variable value 2', { exact: true })).toHaveValue('ordinary-fixture-value')
  await expect(native.getByLabel('Variable value 3', { exact: true })).toHaveValue('')
  await page.keyboard.press('Escape')
  await submitRealChat('verify persisted provider configuration')
  await waitForRealReply('verify persisted provider configuration')
  const requests = readFileSync(path.join(tempRoot, 'codex-state.json.requests'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(requests.filter(request => request.method === 'fixture/startup').at(-1)).toMatchObject({
    args: expect.arrayContaining(['--config', 'fixture_setting=test-value']),
    home: path.join(tempRoot, 'codex-home'), marker: 'ordinary-fixture-value', secret: 'synthetic-fixture-secret',
  })
  native = await openNativeProviderSettings()
  await native.getByRole('button', { name: 'Remove variable', exact: true }).nth(2).click()
  await native.getByRole('button', { name: 'Remove variable', exact: true }).nth(1).click()
  await saveProvider(native)
  await restartCate()
  await submitRealChat('verify removed environment variables')
  await waitForRealReply('verify removed environment variables')
  const afterRemoval = readFileSync(path.join(tempRoot, 'codex-state.json.requests'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const startup = afterRemoval.filter(request => request.method === 'fixture/startup').at(-1)
  expect(startup).toBeDefined()
  expect(startup).not.toHaveProperty('marker')
  expect(startup).not.toHaveProperty('secret')
})

test('real T3 lifecycle settings save preferences and add and remove an isolated provider account', async () => {
  let native = await openNativeProviderSettings()
  await native.locator('summary').filter({ hasText: 'T3 Code preferences' }).click()
  await native.getByRole('switch', { name: 'Legacy token streaming', exact: true }).click()
  await expect(native.getByRole('switch', { name: 'Legacy token streaming', exact: true })).toHaveAttribute('aria-checked', 'true')
  await native.getByRole('combobox', { name: 'Provider status refresh interval', exact: true }).selectOption('60000')
  await native.getByRole('combobox', { name: 'Automatically settle inactive chats', exact: true }).selectOption('7')
  await native.getByRole('combobox', { name: 'Model for generated chat titles', exact: true }).selectOption(JSON.stringify(['codex', 'gpt-5.4']))
  await native.locator('summary').filter({ hasText: 'Additional provider accounts' }).click()
  await native.getByRole('button', { name: 'Add account', exact: true }).click()
  const account = native.getByRole('button', { name: /^Configure Codex · codex-/ })
  await expect(account).toHaveCount(1)
  await account.click()
  await native.locator('summary').filter({ hasText: 'Advanced provider settings' }).click()
  await native.getByLabel('Display name').fill('Second test account')
  await native.getByRole('switch', { name: 'Available in chats', exact: true }).click()
  await saveProvider(native)
  await restartCate()
  native = await openNativeProviderSettings()
  await expect(native.getByRole('switch', { name: 'Available in chats', exact: true })).toHaveAttribute('aria-checked', 'true')
  await native.locator('summary').filter({ hasText: 'T3 Code preferences' }).click()
  await expect(native.getByRole('switch', { name: 'Legacy token streaming', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(native.getByRole('combobox', { name: 'Provider status refresh interval', exact: true })).toHaveValue('60000')
  await expect(native.getByRole('combobox', { name: 'Automatically settle inactive chats', exact: true })).toHaveValue('7')
  await expect(native.getByRole('combobox', { name: 'Model for generated chat titles', exact: true })).toHaveValue(JSON.stringify(['codex', 'gpt-5.4']))
  await native.getByRole('button', { name: 'Configure Second test account', exact: true }).click()
  await expect(native.getByRole('switch', { name: 'Available in chats', exact: true })).toHaveAttribute('aria-checked', 'false')
  await native.locator('summary').filter({ hasText: 'Additional provider accounts' }).click()
  await native.getByRole('button', { name: 'Remove selected account', exact: true }).click()
  await expect(native.getByRole('status')).toHaveText('Settings saved.')
  await expect(native.getByRole('button', { name: 'Configure Second test account', exact: true })).toHaveCount(0)
  await restartCate()
  native = await openNativeProviderSettings()
  await expect(native.getByRole('button', { name: 'Configure Second test account', exact: true })).toHaveCount(0)
})

test('real T3 lifecycle retains the message title and usable chat when title generation fails', async () => {
  const message = 'fixture:title-error repair scrolling'
  await submitRealChat(message)
  await waitForRealReply(message)
  await expect.poll(() => {
    const requests = readFileSync(path.join(tempRoot, 'codex-state.json.requests'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    return requests.some(request => request.method === 'fixture/title' && request.prompt.includes(message))
  }).toBe(true)
  await assertChatTitle(message)
  await restartCate()
  await assertChatTitle(message)
  await submitRealChat('continue after title generation failed')
  await waitForRealReply('continue after title generation failed')
})
