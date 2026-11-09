// Framework-only reproduction: no Cate UI, runtime, preload or page driver.
import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { copyElectronForColdGpuCache } from './fixtures/cold-electron'

test('cold guest GPU work versus a plain Electron parent transform', async () => {
  test.skip(process.env.CATE_GPU_MINIMAL_REPRO !== '1', 'Opt-in isolated cold GPU reproduction')
  test.setTimeout(90_000)
  const copy = copyElectronForColdGpuCache(process.env.CATE_E2E_EXECUTABLE ?? require('electron') as string)
  const entry = path.join(copy.root, 'main.cjs')
  mkdirSync(path.join(copy.root, 'profile'))
  const html = `<style>body{margin:0;background:#222}#world{position:absolute;left:100px;top:80px;will-change:transform}webview{width:900px;height:650px}</style><div id="world"><webview src="data:text/html,Ready"></webview></div>`
  writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(copy.root, 'profile'))});app.commandLine.appendSwitch('deadline-to-synchronize-surfaces','0');app.whenReady().then(()=>{const win=new BrowserWindow({width:1400,height:950,webPreferences:{webviewTag:true,backgroundThrottling:false}});win.loadURL(${JSON.stringify('data:text/html,' + encodeURIComponent(html))})});`)
  const app = await electron.launch({ executablePath: copy.executablePath, args: [entry] })
  const budgetFailures: string[] = []
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => document.querySelector('webview')?.getAttribute('src'))
    await page.waitForTimeout(1000)
    for (const action of ['pan', 'zoom']) {
      const measurement = page.evaluate(async action => {
        const world = document.querySelector<HTMLElement>('#world')!
        const gaps: number[] = []
        let previous = performance.now(), raf = 0
        const started = previous
        const frame = (now: number) => {
          gaps.push(now - previous); previous = now
          const t = now - started
          world.style.transform = action === 'pan' ? `translate(${50 * Math.sin(t / 500)}px,0)` : `scale(${.8 + .2 * Math.sin(t / 500)})`
          raf = requestAnimationFrame(frame)
        }
        raf = requestAnimationFrame(frame)
        ;(window as any).__collecting = true
        await new Promise(resolve => setTimeout(resolve, 5000))
        cancelAnimationFrame(raf); gaps.sort((a, b) => a - b)
        return { fps: gaps.length / 5, p95: gaps[Math.floor(gaps.length * .95)], max: gaps.at(-1) }
      }, action)
      await page.waitForFunction(() => (window as any).__collecting)
      await app.evaluate(({ webContents }) => {
        const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview')!
        void guest.loadURL('https://github.com/').catch(() => {})
      })
      const result = await measurement
      console.log('MINIMAL_GPU_REPRO', action, result)
      if (result.p95 >= 16.7 || result.max! >= 25) budgetFailures.push(`${action}: p95=${result.p95.toFixed(1)} max=${result.max!.toFixed(1)} ms`)
      writeFileSync(test.info().outputPath(`minimal-${action}.json`), JSON.stringify(result, null, 2))
      expect(result.fps).toBeGreaterThan(0)
      await page.evaluate(() => { (window as any).__collecting = false })
    }
    if (process.env.CATE_GPU_MINIMAL_ASSERT_SMOOTH === '1') expect(budgetFailures, 'Plain Electron frame budget failures').toEqual([])
  } finally { await app.close(); rmSync(copy.root, { recursive: true, force: true }) }
})
