import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { launchApp, closeApp, makeHome, makeProject } from './fixtures/electron-app'
import { create } from './fixtures/perf-helpers'

function pdfFixture(pages: number): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] >>`]
  for (let i = 0; i < pages; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${4 + i * 2} 0 R >>`)
    const stream = 'q 0.2 0.4 0.8 rg 40 40 532 712 re f Q\n'
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`)
  }
  let result = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(result.length); result += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const xref = result.length
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(result)
}

function pngFixture(): Buffer {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff
    for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1 }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]); const head = Buffer.alloc(4); head.writeUInt32BE(data.length); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body)); return Buffer.concat([head, body, tail]) }
  const width = 2048, height = 1024
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const pixels = randomBytes((width * 3 + 1) * height)
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

test('media preview retained memory and PDF return scrolling', async () => {
  test.skip(process.env.CATE_MEDIA_PROFILE !== '1' || process.platform !== 'darwin', 'Opt-in macOS media profile')
  test.setTimeout(180_000)
  const home = makeHome(), project = makeProject(home)
  const image = pngFixture()
  writeFileSync(path.join(project, 'noise.png'), image)
  writeFileSync(path.join(project, 'pages.pdf'), pdfFixture(20))
  const { electronApp: app, mainWindow: page } = await launchApp({ home, workspace: project })
  const samples: unknown[] = []
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 950); w.show() })
    const cdp = await page.context().newCDPSession(page)
    const scripts: Array<{ url: string; length: number }> = []
    cdp.on('Debugger.scriptParsed', e => { scripts.push({ url: e.url, length: e.length ?? 0 }) })
    await cdp.send('Debugger.enable')
    const sample = async (scenario: string) => {
      await page.waitForTimeout(1000)
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = await cdp.send('Runtime.getHeapUsage')
      const canvas = await page.locator('[data-testid="file-preview"] canvas').evaluateAll(cs => ({ count: cs.length, active: cs.filter(c => (c as HTMLCanvasElement).width > 1 && (c as HTMLCanvasElement).height > 1).length, bytes: cs.reduce((sum, c) => sum + (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height * 4, 0) }))
      const maps = (await app.evaluate(({ app }) => app.getAppMetrics())).filter(m => m.type === 'Tab' || m.type === 'GPU').map(m => {
        const raw = execFileSync('vmmap', ['-summary', String(m.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
        return { type: m.type, footprint: raw.match(/^Physical footprint:\s+(.+)$/m)?.[1] }
      })
      const row = { scenario, heap, canvas, maps, scripts: [...scripts] }
      samples.push(row)
      writeFileSync(test.info().outputPath('media-memory.json'), JSON.stringify({ imageBytes: image.length, samples }, null, 2))
      console.log('MEDIA', JSON.stringify(row))
    }
    const imagePanel = await create(page, 'editor', { x: 20, y: 20 }, { filePath: path.join(project, 'noise.png') })
    await expect(page.locator('[data-testid="file-preview"] img')).toBeVisible()
    await page.waitForFunction(() => (document.querySelector('[data-testid="file-preview"] img') as HTMLImageElement)?.naturalWidth === 2048)
    await sample('image-preview')
    await page.evaluate(id => window.__cateE2E!.propose({ kind: 'removePanels', ids: [id], discard: [id] }), imagePanel.panelId)
    const pdf = await create(page, 'editor', { x: 20, y: 20 }, { filePath: path.join(project, 'pages.pdf') })
    const preview = page.locator(`[data-node-id="${pdf.nodeId}"] [data-testid="file-preview"]`)
    await expect(preview.locator('canvas')).toHaveCount(20)
    for (let i = 0; i < 20; i++) {
      await preview.locator('canvas').nth(i).evaluate(c => c.parentElement!.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(60)
    }
    await sample('pdf-after-visiting-20-pages')
    await preview.locator('canvas').first().evaluate(c => c.parentElement!.scrollIntoView({ block: 'start' }))
    await expect.poll(() => preview.locator('canvas').first().evaluate(c => { const canvas = c as HTMLCanvasElement; return canvas.width > 1 ? canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[2] : 0 })).toBeGreaterThan(150)
    if (process.env.CATE_MEDIA_EXPECT_BOUNDED === '1') {
      const active = await preview.locator('canvas').evaluateAll(cs => cs.filter(c => (c as HTMLCanvasElement).width > 1).length)
      expect(active).toBeLessThan(6)
    }
    await sample('pdf-return-to-first-page')
    await page.evaluate(id => window.__cateE2E!.propose({ kind: 'removePanels', ids: [id], discard: [id] }), pdf.panelId)
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
    }, path.join(project, 'noise.png'))
    await page.evaluate(() => window.__cateE2E!.openSettings('canvas'))
    await page.getByRole('button', { name: 'Choose…', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('div')].some(e => e.style.backgroundImage.includes('blob:')))
    const wallpaper = await page.evaluate(async () => {
      const layer = [...document.querySelectorAll('div')].find(e => e.style.backgroundImage.includes('blob:'))!
      const url = layer.style.backgroundImage.slice(5, -2)
      const image = new Image(); image.src = url; await image.decode()
      const settings = await window.cateDesktop!.device.get('settings') as { canvasBackgroundImagePath: string }
      const payload = await window.cateDesktop!.dialogs.readCanvasBackground(settings.canvasBackgroundImagePath)
      return { width: image.naturalWidth, bytes: payload?.bytes.byteLength, mimeType: payload?.mimeType }
    })
    expect(wallpaper).toEqual({ width: 2048, bytes: image.length, mimeType: 'image/png' })
    console.log('WALLPAPER', JSON.stringify({ ...wallpaper, previousBase64Bytes: Math.ceil(image.length / 3) * 4 }))
  } finally { await closeApp(app, { home }) }
})
