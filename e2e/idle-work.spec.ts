// An idle app does no per-frame work. With each panel type open and settled,
// nothing may keep the renderer restyling or repainting every frame: no
// infinite animation (a spinner left on a placeholder), no self-rescheduling
// requestAnimationFrame loop. A review over many changed files is the case
// that regressed: every never-loaded diff spun a spinner forever.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'

const WINDOW_MS = 2000

interface IdleWork {
  styleRecalcs: number
  paints: number
  animationFrames: number
  timers: number
  animations: string[]
}

/** What the renderer does over `WINDOW_MS` of doing nothing. */
async function measureIdle(page: Page): Promise<IdleWork> {
  const animations = await page.evaluate(() => {
    const h = window.__cateE2E!
    const typeOf = (nodeId: string | null | undefined) => {
      const panelId = h.nodes().find((n) => n.id === nodeId)?.panelId
      return h.panels().find((p) => p.id === panelId)?.type ?? 'app'
    }
    return document.getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime === Infinity)
      .map((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target as Element | null
        const className = (target?.className as unknown as SVGAnimatedString | undefined)?.baseVal ?? String(target?.className ?? '')
        const where = typeOf(target?.closest('[data-node-id]')?.getAttribute('data-node-id'))
        return `${(a as CSSAnimation).animationName ?? 'script'} on ${target?.tagName.toLowerCase()}.${className.slice(0, 40)} in ${where}`
      })
  })
  const cdp = await page.context().newCDPSession(page)
  const events: { name: string; ph: string }[] = []
  cdp.on('Tracing.dataCollected', (e) => events.push(...(e.value as { name: string; ph: string }[])))
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline'] }, transferMode: 'ReportEvents' })
  await page.waitForTimeout(WINDOW_MS)
  await cdp.send('Tracing.end')
  await done
  await cdp.detach()
  const count = (name: string) => events.filter((e) => e.name === name && e.ph !== 'E').length
  return {
    styleRecalcs: count('UpdateLayoutTree'),
    paints: count('Paint'),
    animationFrames: count('FireAnimationFrame'),
    timers: count('TimerFire'),
    animations,
  }
}

/** Per-frame work is one style recalc or animation frame per display frame:
 *  120 to 240 in the window. Compositor animations sync back a few times a
 *  second each, well under 60. */
const busy = (work: IdleWork) => work.styleRecalcs > 60 || work.animationFrames > 60

let app: ElectronApplication
let page: Page
let home: string

test.beforeAll(async () => {
  home = makeHome()
  const files: Record<string, string> = { 'notes.md': '# Notes\n' }
  for (let i = 0; i < 120; i++) files[`changes/file-${i}.ts`] = `export const value${i} = ${i}\n`
  const project = makeProject(home, { git: true, files })
  ;({ electronApp: app, mainWindow: page } = await launchApp({ home, workspace: project }))
  // A hidden window may not draw; show it so frames run as for a person.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => { w.show(); w.moveTop(); w.focus(); w.webContents.setBackgroundThrottling(false) }))
})
test.afterAll(async () => closeApp(app, { home }))

const SPIN_PATH = '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'
const label = 'claude: fix the flaky tests'

/** Markup of the animations the app uses, and whether each costs per-frame
 *  main-thread work. An infinite animation on an <svg> element restyles every
 *  frame; the same animation on an HTML element runs on the compositor. */
const PROBES: { name: string; html: string; busy: boolean }[] = [
  { name: 'spin on an <svg> (control)', busy: true, html: `<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">${SPIN_PATH}</svg>` },
  { name: 'spin on the span around an <svg> (Spinner)', busy: false, html: `<span class="inline-flex animate-spin"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">${SPIN_PATH}</svg></span>` },
  { name: 'pulse on a div', busy: false, html: '<div class="animate-pulse" style="width:40px;height:8px;background:currentColor"></div>' },
  { name: 'title shimmer (ShimmerText)', busy: false, html: `<span class="cate-shimmer truncate" style="display:block;width:160px">${label}<span aria-hidden="true" class="cate-shimmer-band"><span class="cate-shimmer-copy">${label}</span></span></span>` },
  { name: 'agent cursor idle sway (AgentCursorOverlay)', busy: false, html: `<style>@keyframes cate-agent-pointer-idle { 0%, 100% { transform: rotate(-7deg) scale(0.985); } 50% { transform: rotate(7deg) scale(1.025); } }</style>${
    [0, 15, 30, 45].map((lag, i) => `<div style="position:absolute;left:${40 + i}px;top:40px;width:24px;height:24px"><div style="width:100%;height:100%;transform-origin:12.5% 12.5%;animation:cate-agent-pointer-idle 6s ease-in-out ${-6000 + lag * 4}ms infinite"><svg width="100%" height="100%" viewBox="0 0 32 32" style="display:block;overflow:visible${i === 0 ? ';filter:drop-shadow(0 1.5px 2px rgba(12,54,110,0.24))' : ''}"><path d="M4 9 C2.6 5 5 2.6 9 4 L25 10 C29 11.5 29 15.2 25.2 17 Z" fill="#258dff"/></svg></div></div>`).join('')}` },
]

for (const probe of PROBES) {
  test(`${probe.name} ${probe.busy ? 'is' : 'is not'} per-frame work`, async () => {
    await page.evaluate((html) => {
      const host = document.createElement('div')
      host.id = 'idle-probe'
      host.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;font:13px system-ui'
      host.innerHTML = html
      document.body.appendChild(host)
    }, probe.html)
    const work = await measureIdle(page)
    await page.evaluate(() => document.getElementById('idle-probe')?.remove())
    console.log(probe.name, JSON.stringify(work))
    expect(work.animations.length).toBeGreaterThan(0)
    expect(busy(work)).toBe(probe.busy)
  })
}

// The main window's canvas is under every measurement; a canvas cannot be
// placed on a canvas.
const PANELS: { type: string; options?: Record<string, unknown> }[] = [
  { type: 'terminal' },
  { type: 'editor', options: { filePath: 'notes.md' } },
  { type: 'browser' },
  { type: 'review' },
  { type: 'surface' },
]

for (const { type, options } of PANELS) {
  test(`a settled ${type} panel does no per-frame work`, async () => {
    const { nodeId } = await seedOnCanvas(page, type, { x: 120, y: 120 }, options)
    await page.waitForTimeout(4000)
    // The review lists every changed file, most never scrolled to.
    if (type === 'review') await expect.poll(() => page.locator('[data-review-file]').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(100)
    const work = await measureIdle(page)
    console.log(type, JSON.stringify(work))
    await page.evaluate((id) => {
      const h = window.__cateE2E!
      const panelId = h.nodes().find((n) => n.id === id)?.panelId
      if (panelId) h.propose({ kind: 'removePanels', ids: [panelId] })
    }, nodeId)
    await page.waitForTimeout(500)
    expect(work.animations).toEqual([])
    expect(busy(work)).toBe(false)
  })
}

test('every panel type open together does no per-frame work', async () => {
  // Cascaded so every node is on screen: the canvas skips nodes outside it.
  for (const [i, { type, options }] of PANELS.entries()) {
    await seedOnCanvas(page, type, { x: 40 + i * 90, y: 40 + i * 60 }, options)
  }
  await page.waitForTimeout(5000)
  const work = await measureIdle(page)
  console.log('all', JSON.stringify(work))
  expect(work.animations).toEqual([])
  expect(busy(work)).toBe(false)
})
