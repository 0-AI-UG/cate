// =============================================================================
// The wheel-pan is the one gesture lock owner with no button held: it acquires
// on the first wheel tick and releases on a 150ms quiet timer, so its accounting
// is the most fragile. This drives it hard over a terminal with a large
// scrollback — focused (panel scrolls), unfocused (canvas wheel-pans), wheel
// interleaved with a panel drag, and a workspace switch mid-scroll — and asserts
// the lock never strands.
//
// The watchdog's warning is the detector: if it fires, a stranded
// `canvas-interacting` hold just happened and the message names the owner.
// =============================================================================
import { test, expect } from '@playwright/test'
import { launchApp, closeApp, seedTerminal, getNodeRect } from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page
let warnings: string[] = []

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  warnings = []
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('gestureLockWatchdog')) warnings.push(t)
  })
})
test.afterEach(async () => closeApp(app))

const lockHeld = (p: Page) =>
  p.evaluate(() => document.body.classList.contains('canvas-interacting'))

/** Fill the terminal's scrollback with a lot of lines. */
async function flood(p: Page, nodeId: string, lines: number) {
  // Run a real command so the output flows through the PTY at full rate — a
  // direct write() is swallowed by the shell's line discipline.
  const ok = await p.evaluate(
    ({ id, n }) =>
      window.__cateE2E!.writeTerminal(
        id,
        `for i in $(seq 1 ${n}); do printf 'line %s ${'y'.repeat(150)}\\n' "$i"; done\r`,
      ),
    { id: nodeId, n: lines },
  )
  // Wait for the buffer to stop growing.
  let last = -1
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(1000)
    const len = await p.evaluate((x) => window.__cateE2E!.terminalText(x)?.length ?? 0, nodeId)
    if (len === last) break
    last = len
  }
  return ok
}

test('scrolling a terminal with a huge scrollback does not strand the gesture lock', async () => {
  const nodeId = await seedTerminal(page, { x: 200, y: 200 })
  await page.waitForTimeout(2500) // let the PTY spawn

  const wrote = await flood(page, nodeId, 8000)
  const len = await page.evaluate((id) => window.__cateE2E!.terminalText(id)?.length ?? 0, nodeId)
  console.log('flood accepted:', wrote, '| buffer chars:', len)

  const r = (await getNodeRect(page, nodeId))!
  const cx = r.x + r.width / 2
  const cy = r.y + r.height / 2

  // --- focused terminal: wheel should scroll the panel, not touch the lock ---
  await page.mouse.click(cx, cy)
  await page.waitForTimeout(300)
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -240)
  await page.waitForTimeout(200)
  console.log('after focused up-scroll   | lock:', await lockHeld(page))
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 240)
  await page.waitForTimeout(200)
  console.log('after focused down-scroll | lock:', await lockHeld(page))

  // --- unfocused terminal: wheel drives the canvas wheel-pan (which DOES take
  //     the lock, with a 150ms quiet-timer release) ---
  await page.mouse.click(1100, 800) // defocus
  await page.waitForTimeout(300)
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 200)
  await page.waitForTimeout(600)
  console.log('after unfocused scroll    | lock:', await lockHeld(page))

  // --- rapid alternation: scroll, then immediately grab the panel ---
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -200)
    const rect = (await getNodeRect(page, nodeId))!
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 6)
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width / 2 + 30, rect.y + 20, { steps: 3 })
    await page.mouse.wheel(0, 200) // wheel DURING the drag
    await page.mouse.up()
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(600)
  console.log('after scroll+drag rounds  | lock:', await lockHeld(page))

  // --- scroll, then switch workspace mid-flight ---
  const wsB = await page.evaluate(() => window.__cateE2E!.addWorkspace('B'))
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -200)
  await page.evaluate((id) => window.__cateE2E!.selectWorkspace(id), wsB)
  await page.waitForTimeout(1500)
  console.log('after scroll+ws switch    | lock:', await lockHeld(page))

  await page.waitForTimeout(2000) // give the watchdog room to report a leak
  console.log('watchdog warnings:', warnings.length ? warnings : 'none')
  expect(warnings, `watchdog fired — a leak occurred:\n${warnings.join('\n')}`).toEqual([])
  expect(await lockHeld(page)).toBe(false)
})
