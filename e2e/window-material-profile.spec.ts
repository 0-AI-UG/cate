import { test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { launchApp, closeApp } from './fixtures/electron-app'

for (const [iteration, opaque] of [false, true, true, false].entries()) {
test(`compares native window memory ${opaque ? 'opaque' : 'vibrant'} ${iteration}`, async () => {
  test.skip(process.env.CATE_MATERIAL_PROFILE !== '1' || process.platform !== 'darwin', 'Opt-in macOS profile')
  const { electronApp: app, mainWindow: page } = await launchApp()
  const rows: unknown[] = []
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show() })
    {
      await app.evaluate(({ BrowserWindow }, opaque) => {
        const w = BrowserWindow.getAllWindows()[0]
        w.setVibrancy(opaque ? null : 'sidebar')
        w.setBackgroundColor(opaque ? '#1e1e1e' : '#00000000')
      }, opaque)
      await page.waitForTimeout(6000)
      const maps = (await app.evaluate(({ app }) => app.getAppMetrics())).map(m => {
        const raw = execFileSync('vmmap', ['-summary', String(m.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
        return { type: m.type, footprint: raw.match(/^Physical footprint:\s+(.+)$/m)?.[1] }
      })
      rows.push({ opaque, maps });console.log('MATERIAL', JSON.stringify({ opaque, maps }))
    }
    writeFileSync(test.info().outputPath('material-memory.json'), JSON.stringify(rows, null, 2))
  } finally { await closeApp(app) }
})

}
