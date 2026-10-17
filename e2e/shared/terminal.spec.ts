// Shared workspace, terminal panel: one PTY, every viewer types into it and
// sees its screen; lifecycle ops from either client show in both.

import { test, expect } from '@playwright/test'
import {
  describeShared,
  doc,
  sessionOp,
  sessionOpError,
  seedShared,
  snapshot,
  terminalText,
  writeTerminal,
  type SharedClient,
} from '../fixtures/shared-workspace'

type TerminalSnapshot = { ptyId: string | null; status: string; cwd: string | null; activity: { type: string; processName?: string }; exitCode: number | null }
const term = (c: SharedClient, id: string) => snapshot<TerminalSnapshot>(c, id)

async function typeInto(c: SharedClient, nodeId: string, text: string) {
  const overlay = c.page.locator(`[data-node-id="${nodeId}"] [data-unfocused-overlay]`)
  if (await overlay.count()) await overlay.click()
  await c.page.focus(`[data-node-id="${nodeId}"] .xterm-helper-textarea`)
  await c.page.keyboard.type(text)
  await c.page.keyboard.press('Enter')
}

describeShared('terminal', (pair) => {
  let panelId: string
  let nodeId: string

  test('a terminal made in A runs one PTY both clients attach to', async () => {
    const { a, b } = pair()
    ;({ panelId, nodeId } = await seedShared(pair(), a, 'terminal', { x: 80, y: 80 }))
    await expect.poll(async () => (await term(a, panelId))?.status, { timeout: 20_000 }).toBe('running')
    const ptyA = (await term(a, panelId))!.ptyId
    await expect.poll(async () => (await term(b, panelId))?.ptyId).toBe(ptyA)
    await b.page.waitForSelector(`[data-node-id="${nodeId}"] .xterm`, { timeout: 20_000 })
    await expect.poll(() => terminalText(a, panelId), { timeout: 20_000 }).toMatch(/\S/)
  })

  test('keystrokes in B reach the PTY and render in A', async () => {
    const { a, b } = pair()
    await typeInto(b, nodeId, 'echo from-b-$((20+22))')
    await expect(a.page.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText('from-b-42', { timeout: 20_000 })
  })

  test('keystrokes in A render in B', async () => {
    const { a, b } = pair()
    await typeInto(a, nodeId, 'echo from-a-$((50+5))')
    await expect(b.page.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText('from-a-55', { timeout: 20_000 })
  })

  test('submit and input ops from B land in the same shell', async () => {
    const { a, b } = pair()
    expect(await sessionOp(b, panelId, { kind: 'submit', text: 'echo submitted-$((3*3))' })).toMatchObject({ ok: true })
    await expect.poll(() => terminalText(a, panelId)).toMatch(/submitted-9/)
    await sessionOp(b, panelId, { kind: 'input', data: 'echo input-$((4*4))\r' })
    await expect.poll(() => terminalText(a, panelId)).toMatch(/input-16/)
  })

  test('shell state is shared: cd in A, pwd from B', async () => {
    const { a, b, project } = pair()
    await writeTerminal(a, panelId, 'mkdir -p shared-dir && cd shared-dir\r')
    await writeTerminal(b, panelId, 'pwd\r')
    await expect.poll(() => terminalText(a, panelId)).toContain(`${project}/shared-dir`)
    await expect.poll(async () => (await term(b, panelId))?.cwd, { timeout: 20_000 }).toBe(`${project}/shared-dir`)
  })

  test('a running program shows as activity in both, and restart without discard is refused', async () => {
    const { a, b } = pair()
    await writeTerminal(a, panelId, 'sleep 120\r')
    for (const c of [a, b]) {
      await expect.poll(async () => (await term(c, panelId))?.activity, { timeout: 20_000 }).toMatchObject({ type: 'running', processName: 'sleep' })
    }
    const refused = await sessionOpError(b, panelId, { kind: 'restart' })
    expect(refused).toBe('dirty')
  })

  test('restart with discard from B gives both clients a fresh PTY', async () => {
    const { a, b } = pair()
    const before = (await term(a, panelId))!.ptyId
    await sessionOp(b, panelId, { kind: 'restart', discard: true })
    for (const c of [a, b]) {
      await expect.poll(async () => {
        const s = await term(c, panelId)
        return s?.status === 'running' && s.ptyId !== before
      }, { timeout: 20_000 }).toBe(true)
    }
    await writeTerminal(b, panelId, 'echo fresh-$((1+1))\r')
    await expect(a.page.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText('fresh-2', { timeout: 20_000 })
  })

  test('terminate from A shows exited in B and keeps the screen', async () => {
    const { a, b } = pair()
    await sessionOp(a, panelId, { kind: 'terminate' })
    await expect.poll(async () => (await term(b, panelId))?.status, { timeout: 20_000 }).toBe('exited')
    await expect(b.page.locator(`[data-node-id="${nodeId}"] .xterm-rows`)).toContainText('fresh-2')
    const refused = await sessionOpError(b, panelId, { kind: 'input', data: 'x' })
    expect(refused).toBe('rejected')
  })

  test('the cate API reads the terminal for either client', async () => {
    const { a, b } = pair()
    await sessionOp(a, panelId, { kind: 'restart', discard: true })
    await expect.poll(async () => (await term(b, panelId))?.status, { timeout: 20_000 }).toBe('running')
    await writeTerminal(a, panelId, 'echo api-read-$((7*6))\r')
    await expect.poll(() => b.page.evaluate(({ panelId, ws }) =>
      window.__cateE2E!.call('api', 'call', { method: 'cate.terminal.read', args: { panelId } }, ws)
        .then((r) => (r as { text?: string }).text ?? JSON.stringify(r)), { panelId, ws: b.workspaceId }), { timeout: 20_000 }).toContain('api-read-42')
  })

  test('closing the terminal in B removes it from A', async () => {
    const { a, b } = pair()
    await sessionOp(b, panelId, { kind: 'terminate' })
    await b.page.evaluate(({ panelId, ws }) => window.__cateE2E!.propose({ kind: 'removePanels', ids: [panelId] } as never, ws), { panelId, ws: b.workspaceId })
    await expect.poll(async () => !!(await doc(a))?.panels[panelId], { timeout: 20_000 }).toBe(false)
    await expect(a.page.locator(`[data-node-id="${nodeId}"]`)).toHaveCount(0)
  })
})
