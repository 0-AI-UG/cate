import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { closeApp, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'
import { launchWithRuntime } from './fixtures/runtime-install'

for (const mode of ['complete', 'interrupt', 'bootstrap-error', 'direct-update', 'direct-bootstrap-error'] as const) test(`real Codex ${mode} and Ctrl+C in an isolated Cate`, async () => {
  test.skip(!process.env.CATE_CODEX_REPRO, 'Manual reproduction with a local Codex binary')
  test.setTimeout(90_000)
  const direct = mode.startsWith('direct-')
  const bootstrapError = mode.endsWith('bootstrap-error')
  const home = makeHome()
  const codexHome = path.join(home, '.codex')
  mkdirSync(codexHome)
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  server.on('connection', (socket) => socket.on('message', (data) => {
    const request = JSON.parse(data.toString())
    console.log('BOOTSTRAP RPC:', request.method)
    if (request.id === undefined) return
    socket.send(JSON.stringify({ id: request.id, ...(request.method === 'account/read'
      ? { error: { code: -32603, message: 'workspace routing discovery timed out' } }
      : { result: request.method === 'initialize' ? { userAgent: 'repro', platformFamily: 'unix', platformOs: 'macos' } : {} }) }))
  }))
  writeFileSync(path.join(codexHome, 'version.json'), JSON.stringify({ latest_version: '99.0.0', last_checked_at: new Date().toISOString() }))
  const bin = path.join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'brew'), `#!/bin/sh\necho TEST_UPDATER_STARTED\nsleep ${mode === 'interrupt' ? 60 : 2}\necho TEST_UPDATER_FINISHED\n`, { mode: 0o755 })
  writeFileSync(path.join(home, '.zshrc'), `export PATH='${bin}':"$PATH"\n`)
  const { electronApp: app, mainWindow: page } = await launchWithRuntime({
    home, workspace: makeProject(home, { git: true }), domTerminals: true,
    env: { CODEX_HOME: codexHome },
  })
  try {
    const { panelId } = await seedOnCanvas(page, 'terminal', { x: 80, y: 80 })
    const read = () => page.evaluate((id) => window.__cateE2E!.terminalText(id), panelId)
    await expect.poll(read).toMatch(/%|\$/)
    const address = server.address() as { port: number }
    await page.evaluate(({ id, command }) => window.__cateE2E!.writeTerminal(id, command), {
      id: panelId, command: `export CODEX_HOME='${codexHome}'; ${direct ? 'exec ' : ''}/opt/homebrew/bin/codex ${bootstrapError ? `--remote ws://127.0.0.1:${address.port} -c check_for_update_on_startup=false` : '--no-daemon'}; echo CODEX_EXITED_$?\r`,
    })
    await page.waitForTimeout(8000)
    console.log('CODEX BEFORE INPUT:', await read())
    const input = page.locator('.xterm-helper-textarea').last()
    await input.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(4000)
    if (mode === 'complete' || mode === 'direct-update') await expect.poll(read, { timeout: 20_000 }).toContain('TEST_UPDATER_FINISHED')
    console.log('CODEX AFTER ENTER:', await read())
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await page.waitForTimeout(2000)
    console.log('CODEX AFTER CTRL+C:', await read())
    console.log('SESSION:', await page.evaluate((id) => window.__cateE2E!.sessionSnapshot(id), panelId))
    await page.screenshot({ path: `output/codex-interrupt-${mode}.png` })
    if (bootstrapError) await expect.poll(read).toContain('workspace routing discovery timed out')
    if (direct) {
      await expect.poll(() => page.evaluate((id) => window.__cateE2E!.sessionSnapshot(id), panelId)).toMatchObject({ status: 'exited' })
      return
    }
    await page.keyboard.type('echo SHELL_RESPONDS')
    await page.keyboard.press('Enter')
    await expect.poll(read).toMatch(/\nSHELL_RESPONDS\r?\n/)
  } finally {
    for (const client of server.clients) client.terminate()
    server.close()
    await closeApp(app, { home })
  }
})
