// The in-app canvas context menu: a right click on empty canvas opens a
// cascading menu (Add > Terminal / Note / Text, the canvas actions), every
// column stays inside the window, and a block lands at the canvas point taken
// at the click (zoom and pan applied), starts in editing and is saved with the
// workspace.

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, closeApp, makeHome } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let workspaceId: string
let home: string

async function launch(settings: Record<string, unknown> = {}) {
  home = makeHome()
  const userDataDir = path.join(home, 'ud')
  mkdirSync(userDataDir, { recursive: true })
  if (Object.keys(settings).length) writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(settings))
  const launched = await launchApp({ home, userDataDir })
  app = launched.electronApp
  page = launched.mainWindow
  workspaceId = launched.workspaceId!
}

test.afterEach(async () => closeApp(app, { home }))

const menus = () => page.locator('[data-cascading-menu] [role="menu"]')
const menuItem = (label: string) => page.locator('[data-cascading-menu] [role="menuitem"]', { hasText: new RegExp(`^${label}$`) })

async function viewport(): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
}

async function expectInsideWindow(index: number) {
  const box = (await menus().nth(index).boundingBox())!
  const { width, height } = await viewport()
  expect(box.x, `column ${index} left`).toBeGreaterThanOrEqual(0)
  expect(box.y, `column ${index} top`).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, `column ${index} right`).toBeLessThanOrEqual(width)
  expect(box.y + box.height, `column ${index} bottom`).toBeLessThanOrEqual(height)
}

async function rightClick(x: number, y: number) {
  await page.mouse.click(x, y, { button: 'right' })
  await expect(menus().first()).toBeVisible()
}

/** Waits for the node holding `selector` to finish its enter animation
 *  (the windowless harness runs animation frames slowly). */
async function settled(selector: string) {
  await expect.poll(() => page.evaluate((selector) => {
    const node = document.querySelector(selector)?.closest<HTMLElement>('[data-node-id]')
    return node ? getComputedStyle(node).opacity : null
  }, selector), { timeout: 10_000 }).toBe('1')
}

/** Opens Add > Terminal from a menu already open. */
async function openTerminalSubmenu() {
  await menuItem('Add').hover()
  await expect(menus()).toHaveCount(2)
  await menuItem('Terminal').hover()
  await expect(menus()).toHaveCount(3)
}

test('the menu and its submenus stay inside the window near every edge', async () => {
  await launch()
  const canvas = (await page.locator('[data-canvas-container]').boundingBox())!
  const corners = {
    'bottom-right': { x: canvas.x + canvas.width - 6, y: canvas.y + canvas.height - 6 },
    'top-right': { x: canvas.x + canvas.width - 6, y: canvas.y + 60 },
    'bottom-left': { x: canvas.x + 20, y: canvas.y + canvas.height - 6 },
    'middle': { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 },
  }
  for (const [name, point] of Object.entries(corners)) {
    await test.step(name, async () => {
      await rightClick(point.x, point.y)
      await expectInsideWindow(0)
      await openTerminalSubmenu()
      await expectInsideWindow(1)
      await expectInsideWindow(2)
      await page.screenshot({ path: test.info().outputPath(`menu-${name}.png`) })
      // The submenus do not cover the column they came from.
      const [root, add] = [(await menus().nth(0).boundingBox())!, (await menus().nth(1).boundingBox())!]
      expect(add.x >= root.x + root.width - 12 || add.x + add.width <= root.x + 12, 'Add column beside the root').toBe(true)
      await expect(menus().nth(2).getByRole('menuitem').first()).toHaveText('New Terminal')
      await page.keyboard.press('Escape')
      await expect(menus()).toHaveCount(0)
    })
  }
})

test('a note lands at the clicked canvas point under zoom, starts editing and is saved with the workspace', async () => {
  await launch()
  const zoom = 0.5
  const offset = { x: 40, y: 30 }
  await page.evaluate(({ zoom, offset }) => {
    window.__cateE2E!.setZoom(zoom)
    window.__cateE2E!.setViewportOffset(offset)
  }, { zoom, offset })
  expect(await page.evaluate(() => window.__cateE2E!.zoom())).toBeCloseTo(zoom)

  const canvas = (await page.locator('[data-canvas-container]').boundingBox())!
  const click = { x: canvas.x + 300, y: canvas.y + 250 }
  // view → canvas: (view - offset) / zoom
  const expected = { x: (click.x - canvas.x - offset.x) / zoom, y: (click.y - canvas.y - offset.y) / zoom }

  await rightClick(click.x, click.y)
  await menuItem('Add').hover()
  await menuItem('Note').click()
  await expect(menus()).toHaveCount(0)

  const note = page.locator('textarea[data-text-block="note"]')
  await expect(note).toBeVisible()
  await expect(note).toBeFocused()
  const created = await page.evaluate(() => window.__cateE2E!.panels().find((p) => p.type === 'note'))
  expect(created).toBeTruthy()
  const node = await page.evaluate((panelId) => window.__cateE2E!.nodes().find((n) => n.panelId === panelId), created!.id)
  expect(node!.origin.x).toBeCloseTo(expected.x, 0)
  expect(node!.origin.y).toBeCloseTo(expected.y, 0)
  // The view did not jump to centre the new note.
  expect(await page.evaluate(() => window.__cateE2E!.zoom())).toBeCloseTo(zoom)

  await page.keyboard.type('hello from zoom')
  await settled('textarea[data-text-block="note"]')
  await page.screenshot({ path: test.info().outputPath('note-zoomed.png') })
  await expect.poll(() => page.evaluate(({ ws, id }) => (window.__cateE2E!.document(ws) as unknown as { panels: Record<string, { fields: Record<string, unknown> }> }).panels[id]?.fields.text, { ws: workspaceId, id: created!.id }))
    .toBe('hello from zoom')

  // The runtime wrote words and position to the workspace's document.json
  // (`{ seq, document }`).
  type SavedDoc = {
    panels: Record<string, { fields: Record<string, unknown> }>
    canvases: Record<string, { nodes: Record<string, { id: string; rect: { origin: { x: number; y: number } } }> }>
  }
  const savedDoc = (): SavedDoc | null => {
    const dir = path.join(home, '.cate', 'workspaces')
    for (const id of existsSync(dir) ? readdirSync(dir) : []) {
      const file = path.join(dir, id, 'document.json')
      if (!existsSync(file)) continue
      const doc = (JSON.parse(readFileSync(file, 'utf8')) as { document?: SavedDoc }).document
      if (doc?.panels[created!.id]) return doc
    }
    return null
  }
  await expect.poll(() => savedDoc()?.panels[created!.id]?.fields.text ?? null, { timeout: 15_000 }).toBe('hello from zoom')
  const savedNode = Object.values(savedDoc()!.canvases).flatMap((c) => Object.values(c.nodes)).find((n) => n.id === node!.id)!
  expect(savedNode.rect.origin.x).toBeCloseTo(expected.x, 0)
  expect(savedNode.rect.origin.y).toBeCloseTo(expected.y, 0)
})

test('a text block starts editing, and a right click on a panel keeps the panel menu', async () => {
  await launch()
  const canvas = (await page.locator('[data-canvas-container]').boundingBox())!
  await rightClick(canvas.x + 200, canvas.y + 200)
  await menuItem('Add').hover()
  await menuItem('Text').click()
  const text = page.locator('textarea[data-text-block="text"]')
  await expect(text).toBeFocused()
  await page.keyboard.type('Heading')
  await expect(text).toHaveValue('Heading')
  await settled('textarea[data-text-block="text"]')

  // The field fits inside its node (no overflow, no scrollbars).
  const box = (await text.boundingBox())!
  const node = (await page.locator('[data-node-id]', { has: text }).boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(node.y + node.height + 1)
  expect(box.x + box.width).toBeLessThanOrEqual(node.x + node.width + 1)

  // On a panel the canvas menu does not open (the panel keeps its own menu).
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.waitForTimeout(300)
  await expect(menus()).toHaveCount(0)
})

/** The canvas node holding the panel of `type`. */
const nodeOf = (type: string) => page.evaluate((type) => {
  const panel = window.__cateE2E!.panels().find((p) => p.type === type)
  return panel ? window.__cateE2E!.nodes().find((n) => n.panelId === panel.id) ?? null : null
}, type)

test('loose text: no box, coloured, moved by dragging, edited by a click, gone when left empty', async () => {
  await launch()
  const canvas = (await page.locator('[data-canvas-container]').boundingBox())!
  await rightClick(canvas.x + 200, canvas.y + 220)
  await menuItem('Add').hover()
  await menuItem('Text').click()
  const text = page.locator('textarea[data-text-block="text"]')
  await expect(text).toBeFocused()
  await page.keyboard.type('Claude Code')
  await page.getByRole('button', { name: 'Red', exact: true }).click()
  await expect(text).toBeFocused()
  await expect(text).toHaveCSS('color', 'rgb(255, 95, 87)')
  await page.keyboard.press('Escape')
  await expect(text).not.toBeFocused()
  await settled('textarea[data-text-block="text"]')
  // One line: the block grows sideways with the words instead of wrapping.
  expect((await text.boundingBox())!.height).toBeLessThan(50)

  // No tab bar and no frame around it.
  const node = page.locator('[data-node-id]', { has: text })
  await expect(node.locator('.dock-tab-bar')).toHaveCount(0)
  await expect(node).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

  // A drag moves it; the click that ends a drag does not start editing.
  const before = (await nodeOf('text'))!
  const box = (await text.boundingBox())!
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y + box.height / 2 + 60, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await nodeOf('text'))!.origin.x).toBeGreaterThan(before.origin.x + 40)
  await expect(text).not.toBeFocused()

  // A click puts the caret back in it.
  const moved = (await text.boundingBox())!
  await page.mouse.click(moved.x + moved.width / 2, moved.y + moved.height / 2)
  await expect(text).toBeFocused()
  await page.screenshot({ path: test.info().outputPath('loose-text.png') })

  // A second text left empty goes away.
  await page.keyboard.press('Escape')
  await rightClick(canvas.x + 500, canvas.y + 420)
  await menuItem('Add').hover()
  await menuItem('Text').click()
  await expect(page.locator('textarea[data-text-block="text"]')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(page.locator('textarea[data-text-block="text"]')).toHaveCount(1)
  expect(await page.evaluate(() => window.__cateE2E!.panels().filter((p) => p.type === 'text').length)).toBe(1)
})

test('a sticky note: paper with no tab bar, moved by its top band', async () => {
  await launch()
  const canvas = (await page.locator('[data-canvas-container]').boundingBox())!
  await rightClick(canvas.x + 180, canvas.y + 160)
  await menuItem('Add').hover()
  await menuItem('Note').click()
  const field = page.locator('textarea[data-text-block="note"]')
  await expect(field).toBeFocused()
  await expect(field).toHaveAttribute('placeholder', 'Click to edit…')
  await settled('textarea[data-text-block="note"]')
  const node = page.locator('[data-node-id]', { has: field })
  await expect(node.locator('.dock-tab-bar')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('sticky-note.png') })

  const before = (await nodeOf('note'))!
  const band = (await page.locator('[data-note-handle]').boundingBox())!
  await page.mouse.move(band.x + 40, band.y + band.height / 2)
  await page.mouse.down()
  await page.mouse.move(band.x + 140, band.y + band.height / 2 + 50, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await nodeOf('note'))!.origin.x).toBeGreaterThan(before.origin.x + 60)
})

test('the menu speaks Portuguese with the pt-BR language', async () => {
  await launch({ language: 'pt-BR' })
  const canvas = (await page.locator('[data-canvas-container]').boundingBox())!
  await rightClick(canvas.x + 200, canvas.y + 200)
  await menuItem('Adicionar').hover()
  await expect(menus()).toHaveCount(2)
  await expect(menuItem('Nota')).toBeVisible()
  await expect(menuItem('Texto')).toBeVisible()
  await menuItem('Terminal').hover()
  await expect(menuItem('Novo terminal')).toBeVisible()
  await expect(menuItem('Ajustar à tela')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('menu-pt-BR.png') })
})
