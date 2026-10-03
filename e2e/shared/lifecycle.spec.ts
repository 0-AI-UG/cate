// Shared workspace lifecycle through the UI: inviting a device, removing it,
// and stopping the runtime, with everything that hangs off each.

import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { answerDialogs, closeApp, launchApp, type LaunchResult } from '../fixtures/electron-app'
import { TRANSPORTS, call, hasLan, launchSharedPair, seedShared, terminalText, writeTerminal, type SharedPair } from '../fixtures/shared-workspace'

type Presence = { clients: { clientId: string; device: { name: string; keyFingerprint: string } }[] }
const presence = (page: LaunchResult['mainWindow'], ws?: string) => page.evaluate((ws) => window.__cateE2E!.presence(ws), ws) as Promise<Presence>
const connectionState = (page: LaunchResult['mainWindow'], ws: string) => page.evaluate((ws) => window.__cateE2E!.connection(ws)?.state ?? null, ws)

test.describe('invite and remove a device [network]', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!hasLan, 'no LAN address on this host')
  let pair: SharedPair | undefined
  let c: LaunchResult | undefined
  let cWorkspace = ''
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    pair = await launchSharedPair('network')
  })
  test.afterAll(async () => {
    await closeApp(c?.electronApp)
    await pair?.close()
  })

  test('A adds a device in Settings; C types the code and is in the workspace', async () => {
    const p = pair!
    const { panelId } = await seedShared(p, p.a, 'terminal', { x: 80, y: 80 })
    p.a.page.evaluate(() => window.__cateE2E!.openSettings('devices'))
    await p.a.page.getByRole('button', { name: 'Add device' }).click()
    const code = (await p.a.page.locator('[aria-label="Pairing code"] code').textContent())!.trim()
    expect(code).toMatch(/\S{8,}/)

    c = await launchApp({ workspace: false, domTerminals: true })
    await c.mainWindow.locator('[data-sidebar-empty]').getByRole('button', { name: 'Join a Workspace' }).click()
    await c.mainWindow.getByRole('textbox', { name: 'Pairing code' }).fill(code)
    await c.mainWindow.getByRole('button', { name: 'Join', exact: true }).click()

    await expect.poll(() => c!.mainWindow.evaluate(() => window.__cateE2E!.workspaceIds()), { timeout: 30_000 }).toHaveLength(1)
    cWorkspace = (await c.mainWindow.evaluate(() => window.__cateE2E!.workspaceIds()))[0]!
    await expect.poll(() => connectionState(c!.mainWindow, cWorkspace), { timeout: 30_000 }).toBe('connected')
    // C sees the workspace: A's terminal, its screen, and three clients.
    await expect.poll(async () => !!(await c!.mainWindow.evaluate((ws) => window.__cateE2E!.document(ws), cWorkspace))?.panels[panelId]).toBe(true)
    await expect.poll(() => c!.mainWindow.evaluate(({ id, ws }) => window.__cateE2E!.terminalText(id, ws), { id: panelId, ws: cWorkspace }), { timeout: 20_000 }).toMatch(/\S/)
    await expect.poll(async () => (await presence(p.a.page)).clients.length).toBe(3)
    // A's open device list shows C without reopening the page.
    const cId = await c.mainWindow.evaluate(() => window.__cateE2E!.clientId())
    const cKey = (await presence(p.a.page)).clients.find((x) => x.clientId === cId)!.device.keyFingerprint
    await expect(p.a.page.locator('[aria-label="Paired devices"] li', { hasText: cKey })).toHaveCount(1, { timeout: 15_000 })
  })

  test('A removes C: C is refused and cut off, B stays', async () => {
    const p = pair!
    const cId = await c!.mainWindow.evaluate(() => window.__cateE2E!.clientId())
    const cKey = (await presence(p.a.page)).clients.find((x) => x.clientId === cId)!.device.keyFingerprint
    const row = p.a.page.locator('[aria-label="Paired devices"] li', { hasText: cKey })
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    await answerDialogs(p.a.app.electronApp)
    await row.getByRole('button', { name: /^Remove / }).click()

    await expect(row).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => connectionState(c!.mainWindow, cWorkspace), { timeout: 20_000 }).toBe('refused')
    await expect(c!.mainWindow.locator('[data-connection-blocker]')).toContainText(/not paired|refused/i)
    await expect.poll(async () => (await presence(p.a.page)).clients.map((x) => x.clientId)).not.toContain(cId)
    expect(await connectionState(p.b.page, p.b.workspaceId)).toBe('connected')
    // The code C used cannot be used again either.
    await expect(p.a.page.getByRole('button', { name: 'New code' })).toBeVisible()
  })
})

for (const transport of TRANSPORTS) {
  test.describe(`stopping the runtime [${transport}]`, () => {
    test.skip(transport === 'network' && !hasLan, 'no LAN address on this host')
    let pair: SharedPair | undefined
    test.afterEach(async () => { await pair?.close(); pair = undefined })

    test('B stops it from Settings: its processes end, both clients stay stopped until they start it again', async () => {
      test.setTimeout(120_000)
      pair = await launchSharedPair(transport)
      const p = pair
      const { panelId } = await seedShared(p, p.a, 'terminal', { x: 80, y: 80 })
      await expect.poll(() => terminalText(p.a, panelId), { timeout: 20_000 }).toMatch(/\S/)
      await writeTerminal(p.a, panelId, 'sleep 600 & p=$! ; echo PID=$p\r')
      await expect.poll(async () => /PID=(\d+)/.exec(await terminalText(p.a, panelId))?.[1], { timeout: 20_000 }).toBeTruthy()
      const pid = Number(/PID=(\d+)/.exec(await terminalText(p.a, panelId))![1])
      const info = await call<{ runtimeId: string }>(p.a, 'runtime', 'info')
      const runtimeJson = path.join(p.homeA, '.cate', 'workspaces', info.runtimeId, 'runtime.json')
      expect(existsSync(runtimeJson)).toBe(true)

      await p.b.page.evaluate(() => window.__cateE2E!.openSettings('runtime'))
      await p.b.page.getByRole('button', { name: 'Stop…' }).click()
      await p.b.page.getByRole('button', { name: 'Stop runtime' }).click()

      const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
      await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false)
      for (const c of [p.a, p.b]) {
        await expect.poll(() => connectionState(c.page, c.workspaceId), { timeout: 20_000 }).not.toBe('connected')
      }
      // Stopped on purpose: nobody restarts it, both say so in the workspace.
      await p.a.page.waitForTimeout(3_000)
      for (const c of [p.a, p.b]) {
        expect(await connectionState(c.page, c.workspaceId)).toBe('stopped')
        await expect(c.page.locator('[data-connection-blocker]')).toContainText('Runtime stopped')
        await expect(c.page.locator(`[data-workspace-id="${c.workspaceId}"] [data-connection-status]`)).toHaveAttribute('aria-label', /stopped/)
      }
      // The daemon itself is gone (runtime.json stays; readers check liveness).
      const daemonPid = (JSON.parse(readFileSync(runtimeJson, 'utf8')) as { pid: number }).pid
      await expect.poll(() => alive(daemonPid), { timeout: 20_000 }).toBe(false)

      // A starts it again; B follows when it asks to.
      await p.a.page.locator('[data-connection-blocker]').getByRole('button', { name: 'Start again' }).click()
      await expect.poll(() => connectionState(p.a.page, p.a.workspaceId), { timeout: 30_000 }).toBe('connected')
      await expect(p.a.page.locator('[data-connection-blocker]')).toHaveCount(0)
      // B is still in the Settings it stopped from.
      await p.b.page.keyboard.press('Escape')
      await p.b.page.locator('[data-connection-blocker]').getByRole('button', { name: 'Start again' }).click()
      await expect.poll(() => connectionState(p.b.page, p.b.workspaceId), { timeout: 30_000 }).toBe('connected')
      // The terminal comes back with a new shell for both.
      for (const c of [p.a, p.b]) await expect.poll(() => terminalText(c, panelId), { timeout: 20_000 }).toMatch(/\S/)
    })
  })
}
