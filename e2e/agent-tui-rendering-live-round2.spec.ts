// Production TerminalView + real PTYs, no authenticated model turns.
import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, closeApp, expectTerminalText } from './fixtures/electron-app'
import { create, installPerfHelpers, waitForPty } from './fixtures/perf-helpers'

test('alternate-screen jobs survive overview, culling and remount', async () => {
  test.skip(process.env.CATE_AGENT_TUI_LIVE !== '1', 'Opt-in isolated production TUI integration')
  test.setTimeout(180_000)
  const lock = '/private/tmp/cate-ram-round2-profile.lock'
  const owner = JSON.stringify({ track: 'agent-tui-rendering-round2-live', pid: process.pid })
  mkdirSync(lock)
  writeFileSync(path.join(lock, 'owner'), owner)
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    launched = await launchApp() // No global context rejection; actual production budget.
    const { electronApp: app, mainWindow: page } = launched
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show(); w.focus() })
    await installPerfHelpers(page)
    await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'autoSuspendIdleTerminals', value: false }))
    const ids: string[] = [], nodes: string[] = [], ptyIds: string[] = []
    // String.raw preserves one backslash for Node to interpret as a JS escape.
    const script = String.raw`
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\x1b[?1049h\x1b[?1h\x1b[?1000h\x1b[?1006h');
let tick = 0;
let input = '';
const draw = () => process.stdout.write('\x1b[H\x1b[2J\x1b[32mAGENT-TUI heartbeat=' + ++tick + ' 界 ✓\x1b[0m\r\nINPUT=' + input + '\r\n❯ Ready');
process.stdin.on('data', b => { input = Buffer.from(b).toString('hex'); draw(); });
setInterval(draw, 100);
draw();
`
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    for (let i = 0; i < 3; i++) {
      const { panelId, nodeId } = await create(page, 'terminal', { x: 20 + i * 40, y: 20 + i * 40 })
      ids.push(panelId); nodes.push(nodeId)
      ptyIds.push(await waitForPty(page, panelId))
      await page.evaluate(({ id, command }) => window.__cateE2E!.writeTerminal(id, command), { id: panelId, command: `${quote(process.execPath)} -e ${quote(script)}\n` })
      await expectTerminalText(page, panelId, 'AGENT-TUI')
    }
    await expect(page.locator('.xterm')).toHaveCount(3)
    await expect(page.locator('.xterm canvas')).toHaveCount(4)
    const statuses = () => page.evaluate(() => window.__cateE2E!.call('process', 'list')) as Promise<Array<{ id: string; pid: number; alive: boolean; suspended: boolean }>>
    const readScreens = () => page.evaluate(ids => Promise.all(ids.map(id =>
      window.__cateE2E!.call('process', 'read', { id }),
    )), ptyIds) as Promise<Array<{ alt: boolean; text: string }>>
    // The shell echoes the launch command before the TUI starts; text alone is not readiness.
    await expect.poll(async () => (await readScreens()).map(screen => screen.alt)).toEqual([true, true, true])
    const beforeScreens = await readScreens()
    expect(beforeScreens.map(screen => screen.alt)).toEqual([true, true, true])
    const before = await statuses()
    const terminal = page.locator(`[data-node-id="${nodes[2]}"] .xterm`)
    await terminal.locator('textarea').focus()
    await page.keyboard.type('z')
    await expectTerminalText(page, ids[2], 'INPUT=7a')
    await page.keyboard.press('ArrowUp')
    await expectTerminalText(page, ids[2], 'INPUT=1b4f41')
    await page.evaluate(() => window.__cateE2E!.setZoom(.35))
    await expect(page.locator('.xterm-rows').first()).toContainText('AGENT-TUI')
    await page.evaluate(() => window.__cateE2E!.setViewport({ x: -20000, y: -20000 }))
    await expect(page.locator('.xterm')).toHaveCount(0)
    const hidden = await page.evaluate(id => window.__cateE2E!.terminalText(id), ids[0])
    await page.waitForTimeout(1000)
    const later = await page.evaluate(id => window.__cateE2E!.terminalText(id), ids[0])
    expect(later).not.toBe(hidden)
    expect(later).toContain('AGENT-TUI')
    const start = Date.now()
    await page.evaluate(() => { window.__cateE2E!.setZoom(1); window.__cateE2E!.setViewport({ x: 0, y: 0 }) })
    await expect(page.locator('.xterm')).toHaveCount(3)
    await expect(page.locator('.xterm-rows').first()).toContainText('AGENT-TUI')
    await expect(page.locator('.xterm canvas')).toHaveCount(4)
    const remountMs = Date.now() - start
    const afterScreens = await readScreens()
    expect(afterScreens.map(screen => screen.alt)).toEqual([true, true, true])
    const after = await statuses()
    expect(after.map(s => [s.id, s.pid])).toEqual(before.map(s => [s.id, s.pid]))
    expect(after.every(s => s.alive && !s.suspended)).toBe(true)
    await terminal.locator('textarea').focus()
    await page.keyboard.type('x')
    await expectTerminalText(page, ids[2], 'INPUT=78')
    const result = { ptyIds, beforeScreens, afterScreens, before, after, hidden, later, remountMs, input: ['z', 'application ArrowUp', 'x after remount'], productionTerminalCanvases: 4 }
    writeFileSync(test.info().outputPath('agent-tui-live.json'), JSON.stringify(result, null, 2))
  } finally {
    try { if (launched) await closeApp(launched.electronApp) }
    finally { if (readFileSync(path.join(lock, 'owner'), 'utf8') === owner) rmSync(lock, { recursive: true }) }
  }
})
