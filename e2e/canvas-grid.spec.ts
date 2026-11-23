import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CANVAS_GRID_SIZE } from '../src/workspace/canvas/contract'
import { launchApp, closeApp, makeHome } from './fixtures/electron-app'

for (const style of ['lines', 'dots'] as const) {
  test(`cached ${style} grid preserves the painted pattern through pan and zoom`, async () => {
    const home = makeHome(), userDataDir = path.join(home, 'ud')
    mkdirSync(userDataDir)
    writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ canvasGridStyle: style }))
    const { electronApp: app, mainWindow: page } = await launchApp({ home, userDataDir })
    try {
      const canvas = page.locator('[data-canvas-container]')
      await expect(canvas.locator('[data-canvas-grid]')).toHaveCSS('background-image', style === 'dots' ? /radial-gradient/ : /linear-gradient/)
      await canvas.evaluate((element: HTMLElement) => {
        element.style.backgroundColor = '#000'
        element.style.setProperty('--grid-line', '#fff')
        element.style.setProperty('--grid-dot', '#fff')
      })
      const bounds = (await canvas.boundingBox())!
      const clip = { x: bounds.x + 50, y: bounds.y + 100, width: 400, height: 300 }
      for (const zoom of [0.25, 0.65, 1, 1.23, 1.0007812499]) {
        const offset = { x: -100023.5, y: 99999.25 }
        const actualZoom = await page.evaluate(({ zoom, offset }) => {
          window.__cateE2E!.setZoom(zoom)
          window.__cateE2E!.setViewportOffset(offset)
          return window.__cateE2E!.zoom()
        }, { zoom, offset })
        const actual = await page.screenshot({ clip, path: test.info().outputPath(`grid-${zoom}.png`) })
        // The original background-position rendering is the visual reference.
        let step = CANVAS_GRID_SIZE * actualZoom
        while (step < 16) step *= 2
        await page.evaluate(({ offset, step }) => {
          const canvas = document.querySelector<HTMLElement>('[data-canvas-container]')!
          const grid = canvas.querySelector<HTMLElement>('[data-canvas-grid]')!
          const rect = canvas.getBoundingClientRect(), css = getComputedStyle(grid)
          const reference = document.createElement('div')
          reference.id = 'grid-reference'
          Object.assign(reference.style, {
            position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
            width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '2147483647',
            backgroundColor: '#000', backgroundImage: css.backgroundImage,
            backgroundSize: `${step}px ${step}px`, backgroundPosition: `${offset.x}px ${offset.y}px`,
          })
          document.body.appendChild(reference)
        }, { offset, step })
        const reference = await page.screenshot({ clip, path: test.info().outputPath(`grid-reference-${zoom}.png`) })
        await page.evaluate(() => document.getElementById('grid-reference')!.remove())
        const pixels = await Promise.all([actual, reference].map(buffer => sharp(buffer).removeAlpha().raw().toBuffer()))
        let error = 0, ink = 0
        for (let i = 0; i < pixels[0].length; i++) {
          error += Math.abs(pixels[0][i] - pixels[1][i])
          ink += pixels[1][i]
        }
        // Subpixel compositor sampling can change edge antialiasing slightly.
        expect(error / ink, `grid phase at zoom ${zoom}`).toBeLessThan(0.75)
      }
    } finally { await closeApp(app, { home }) }
  })
}

test('panning reuses grid and wallpaper pixels instead of painting the viewport again', async () => {
  const home = makeHome(), userDataDir = path.join(home, 'ud')
  mkdirSync(userDataDir)
  writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ canvasGridStyle: 'dots', canvasBackgroundImagePath: 'builtin:snowy-pass', canvasBackgroundImageOpacity: 1 }))
  const { electronApp: app, mainWindow: page } = await launchApp({ home, userDataDir })
  try {
    await expect(page.locator('[data-canvas-background-image]')).toBeVisible()
    const cdp = await page.context().newCDPSession(page)
    let layers: { layerId: string; backendNodeId?: number }[] = []
    cdp.on('LayerTree.layerTreeDidChange', event => { layers = event.layers ?? [] })
    await cdp.send('LayerTree.enable')
    const { root } = await cdp.send('DOM.getDocument')
    const backgrounds: number[] = []
    for (const selector of ['[data-canvas-grid]', '[data-canvas-background-image]']) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      const { node } = await cdp.send('DOM.describeNode', { nodeId })
      backgrounds.push(node.backendNodeId)
    }
    const backgroundLayers = () => layers.filter(layer => backgrounds.includes(layer.backendNodeId!)).map(layer => layer.layerId).sort()
    await expect.poll(() => backgroundLayers().length).toBe(2)
    const cachedLayers = backgroundLayers()
    await page.screenshot() // Finish the initial image decode and raster.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const paints: string[] = []
    cdp.on('LayerTree.layerPainted', event => { if (cachedLayers.includes(event.layerId)) paints.push(event.layerId) })
    await page.evaluate(async () => {
      for (let i = 1; i <= 30; i++) {
        window.__cateE2E!.setViewportOffset({ x: i * 12.25, y: -i * 5.5 })
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
    })
    expect(backgroundLayers()).toEqual(cachedLayers)
    expect(paints, 'background rasterization during a pan').toEqual([])
  } finally { await closeApp(app, { home }) }
})
