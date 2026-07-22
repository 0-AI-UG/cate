// Repro for #521 — terminal focus / clipboard selection mismatch after splits.
//
// Cmd+C in a terminal is Electron's `role: 'copy'` (src/main/menu.ts), which
// fires a native copy at whatever holds DOM focus; xterm answers it only for the
// terminal whose element contains the focused node (its `copy` listener sits on
// terminal.element). So the copy source is decided by DOM focus, never by the
// terminal the selection lives in. These specs pin the observable consequences
// inside one node's split mini-dock: where focus lands after a click, and which
// terminal answers the copy.

import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  seedTerminal,
  resetViewport,
  titleBarCentre,
  getNodeRect,
  dragMouse,
  setZoom,
} from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  await page.evaluate(() => window.__cateE2E!.setActiveLeftSidebarView(null))
  await resetViewport(page)
})
test.afterEach(async () => closeApp(app))

interface Pane {
  index: number
  rect: { x: number; y: number; width: number; height: number }
}

/** Print a marker line in a node's terminal. Written straight to the PTY via the
 *  harness (not typed) so seeding never depends on the focus behaviour under
 *  test — at this point each node still holds exactly one terminal. */
async function seedMarker(p: Page, nodeId: string, marker: string): Promise<void> {
  await p.waitForFunction((id) => window.__cateE2E!.terminalPtyId(id) !== null, nodeId, {
    timeout: 15_000,
  })
  await p.evaluate(
    ([id, m]) => window.__cateE2E!.writeTerminal(id!, `echo ${m}\r`),
    [nodeId, marker],
  )
  await p.waitForTimeout(900)
}

/**
 * Seed two terminals, give each distinct on-screen content, then drop A on B's
 * left edge so both live in ONE node's mini-dock as a horizontal split — the
 * shape the issue describes. Returns the surviving node id.
 */
async function splitTerminalNode(p: Page): Promise<string> {
  // Zoom out first: at zoom 1 a node seeded far right hangs off the 1200px e2e
  // window, and the canvas viewport cull detaches any pane that isn't
  // intersecting (a detached pane can't be clicked or focused). At 0.6 both
  // nodes — and both panes after the split — stay fully on screen.
  await setZoom(p, 0.6)
  await resetViewport(p)

  const a = await seedTerminal(p, { x: 300, y: 100 })
  const b = await seedTerminal(p, { x: 1000, y: 100 })
  await setZoom(p, 0.6)
  await resetViewport(p)
  await p.waitForTimeout(300)

  await seedMarker(p, a, 'LEFTMARK')
  await seedMarker(p, b, 'RIGHTMARK')

  const aGrab = await titleBarCentre(p, a)
  const bRect = (await getNodeRect(p, b))!
  const dropPoint = { x: bRect.x + 8, y: bRect.y + bRect.height / 2 }
  await dragMouse(p, aGrab!, dropPoint, { steps: 25, pauseAtEnd: 50 })

  await p.waitForFunction(
    (id) => document.querySelectorAll(`[data-node-id="${id}"] .xterm`).length === 2,
    b,
    { timeout: 15_000 },
  )
  await p.waitForTimeout(600)
  return b
}

/** Screen rects of the node's two xterm panes, left pane first. */
async function panes(p: Page, nodeId: string): Promise<[Pane, Pane]> {
  const rects = await p.evaluate((id) => {
    const els = [...document.querySelectorAll(`[data-node-id="${id}"] .xterm`)]
    return els.map((el, index) => {
      const r = el.getBoundingClientRect()
      return { index, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
    })
  }, nodeId)
  const sorted = [...rects].sort((l, r) => l.rect.x - r.rect.x)
  return [sorted[0]!, sorted[1]!]
}

/** Index of the pane that owns DOM focus, plus the panes xterm itself considers
 *  focused (it stamps `.focus` on its element). -1 = focus is outside every
 *  terminal (e.g. it fell back to <body>). */
async function focusState(
  p: Page,
  nodeId: string,
): Promise<{ domFocus: number; xtermFocus: number[] }> {
  return p.evaluate((id) => {
    const els = [...document.querySelectorAll(`[data-node-id="${id}"] .xterm`)]
    const owner = (document.activeElement as HTMLElement | null)?.closest('.xterm')
    return {
      domFocus: owner ? els.indexOf(owner) : -1,
      xtermFocus: els.flatMap((el, i) => (el.classList.contains('focus') ? [i] : [])),
    }
  }, nodeId)
}

/** Record every focusin target so a failure shows the churn, not just the end state. */
async function traceFocus(p: Page, nodeId: string): Promise<() => Promise<string[]>> {
  await p.evaluate((id) => {
    const w = window as unknown as { __focusTrace?: string[] }
    w.__focusTrace = []
    document.addEventListener(
      'focusin',
      (e) => {
        const els = [...document.querySelectorAll(`[data-node-id="${id}"] .xterm`)]
        const owner = (e.target as HTMLElement | null)?.closest?.('.xterm')
        w.__focusTrace!.push(owner ? `pane${els.indexOf(owner)}` : 'outside')
      },
      true,
    )
  }, nodeId)
  return () => p.evaluate(() => (window as unknown as { __focusTrace: string[] }).__focusTrace)
}

/**
 * Fire the real thing: webContents.copy() is exactly what Electron's
 * Edit ▸ Copy (`role: 'copy'`, src/main/menu.ts) invokes for Cmd+C. Returns the
 * pane whose xterm element answered the copy event, plus the resulting clipboard.
 */
async function nativeCopy(
  p: Page,
  a: ElectronApplication,
  nodeId: string,
): Promise<{ copyTarget: string; clipboard: string }> {
  await a.evaluate(({ clipboard }) => clipboard.writeText('__CLEARED__'))
  await p.evaluate((id) => {
    const w = window as unknown as { __copyTarget?: string }
    w.__copyTarget = 'none'
    document.addEventListener(
      'copy',
      (e) => {
        const els = [...document.querySelectorAll(`[data-node-id="${id}"] .xterm`)]
        const owner = (e.target as HTMLElement | null)?.closest?.('.xterm')
        w.__copyTarget = owner ? `pane${els.indexOf(owner)}` : 'outside'
      },
      true,
    )
  }, nodeId)
  await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy())
  await p.waitForTimeout(300)
  return {
    copyTarget: await p.evaluate(() => (window as unknown as { __copyTarget: string }).__copyTarget),
    clipboard: await a.evaluate(({ clipboard }) => clipboard.readText()),
  }
}

async function clickPane(p: Page, pane: Pane): Promise<void> {
  await p.mouse.click(pane.rect.x + pane.rect.width / 2, pane.rect.y + pane.rect.height / 2)
}

test('clicking a split sibling leaves focus in the clicked pane', async () => {
  const nodeId = await splitTerminalNode(page)
  const [left, right] = await panes(page, nodeId)
  const dump = await traceFocus(page, nodeId)

  // Focus the left pane, then click the right one — "click terminal A, then B".
  await clickPane(page, left)
  await page.waitForTimeout(800)
  await clickPane(page, right)
  // Past the 500ms re-assert window in TerminalPanel's runFocus loop.
  await page.waitForTimeout(1000)

  const state = await focusState(page, nodeId)
  console.log('focus trace:', (await dump()).join(' → '), '| state:', JSON.stringify(state))
  expect(state.domFocus, 'DOM focus should be in the clicked pane').toBe(right.index)
  expect(state.xtermFocus, 'exactly one pane should consider itself focused').toEqual([
    right.index,
  ])
})

test('rearranging the node keeps copy on the pane holding the selection', async () => {
  const nodeId = await splitTerminalNode(page)
  const [left, right] = await panes(page, nodeId)

  // Select in the LEFT pane.
  await clickPane(page, left)
  await page.waitForTimeout(900)
  await dragMouse(
    page,
    { x: left.rect.x + 4, y: left.rect.y + 4 },
    { x: left.rect.x + left.rect.width - 8, y: left.rect.y + left.rect.height - 8 },
    { steps: 20, pauseAtEnd: 200 },
  )
  await page.waitForTimeout(300)

  const dump = await traceFocus(page, nodeId)
  // Step 5 of the issue: rearrange, then come back to the node. Clicking away and
  // re-focusing the node re-arms BOTH split panes' focus loops (focusEpoch bump),
  // and they race for DOM focus for ~500ms.
  const grab = await titleBarCentre(page, nodeId)
  await dragMouse(page, grab!, { x: grab!.x + 90, y: grab!.y + 40 }, { steps: 15, pauseAtEnd: 80 })
  await page.waitForTimeout(300)
  await page.mouse.click(60, 700) // empty canvas — drops node focus
  await page.waitForTimeout(300)
  const grab2 = await titleBarCentre(page, nodeId)
  await page.mouse.click(grab2!.x, grab2!.y) // re-focus the node
  await page.waitForTimeout(1000)

  const state = await focusState(page, nodeId)
  const { copyTarget, clipboard } = await nativeCopy(page, app, nodeId)
  console.log(
    'after rearrange — focus:', JSON.stringify(state),
    '| trace:', (await dump()).join(' → '),
    '| copy answered by:', copyTarget,
    '| clipboard:', JSON.stringify(clipboard.slice(0, 120)),
  )

  expect(copyTarget, 'copy should still be answered by the pane holding the selection').toBe(
    `pane${left.index}`,
  )
  expect(clipboard).toContain('LEFTMARK')
  expect(clipboard).not.toContain('RIGHTMARK')
})

test('copy takes the selection from the pane the user selected in', async () => {
  const nodeId = await splitTerminalNode(page)
  const [left, right] = await panes(page, nodeId)

  // Land in the left pane first, then click into the right one and select there.
  await clickPane(page, left)
  await page.waitForTimeout(800)
  await clickPane(page, right)
  await page.waitForTimeout(1000)

  // Drag-select the whole visible buffer of the RIGHT pane.
  await dragMouse(
    page,
    { x: right.rect.x + 4, y: right.rect.y + 4 },
    { x: right.rect.x + right.rect.width - 8, y: right.rect.y + right.rect.height - 8 },
    { steps: 20, pauseAtEnd: 200 },
  )
  await page.waitForTimeout(400)

  const { copyTarget, clipboard } = await nativeCopy(page, app, nodeId)
  console.log('copy answered by:', copyTarget, '| clipboard:', JSON.stringify(clipboard))

  expect(copyTarget, 'copy should be answered by the pane holding the selection').toBe(
    `pane${right.index}`,
  )
  expect(clipboard).toContain('RIGHTMARK')
  expect(clipboard).not.toContain('LEFTMARK')
})

test('copy does not return a stale selection from the other pane', async () => {
  const nodeId = await splitTerminalNode(page)
  const [left, right] = await panes(page, nodeId)

  const selectAll = async (pane: Pane): Promise<void> => {
    await dragMouse(
      page,
      { x: pane.rect.x + 4, y: pane.rect.y + 4 },
      { x: pane.rect.x + pane.rect.width - 8, y: pane.rect.y + pane.rect.height - 8 },
      { steps: 20, pauseAtEnd: 200 },
    )
    await page.waitForTimeout(300)
  }

  // The user selected in the RIGHT pane a while ago (stale selection lives on
  // in that terminal), then moved to the LEFT pane and selected there.
  await clickPane(page, right)
  await page.waitForTimeout(900)
  await selectAll(right)
  await clickPane(page, left)
  await page.waitForTimeout(900)
  await selectAll(left)

  // Rearrange + come back, per steps 5-6 of the issue.
  const grab = await titleBarCentre(page, nodeId)
  await dragMouse(page, grab!, { x: grab!.x + 90, y: grab!.y + 40 }, { steps: 15, pauseAtEnd: 80 })
  await page.waitForTimeout(300)
  await page.mouse.click(60, 700)
  await page.waitForTimeout(300)
  const grab2 = await titleBarCentre(page, nodeId)
  await page.mouse.click(grab2!.x, grab2!.y)
  await page.waitForTimeout(1000)

  const { copyTarget, clipboard } = await nativeCopy(page, app, nodeId)
  console.log('stale-selection copy answered by:', copyTarget, '| clipboard:', JSON.stringify(clipboard.slice(0, 120)))

  expect(clipboard, 'copy should return the last selection the user made').toContain('LEFTMARK')
  expect(clipboard, "copy must not return the other pane's stale selection").not.toContain(
    'RIGHTMARK',
  )
})
