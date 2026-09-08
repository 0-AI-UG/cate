import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import { expect, test, type TestInfo } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'
import { act, activeAction, browserInvoke, fixtureEvaluate, observe, target } from './fixtures/browser-control'

let app: ElectronApplication
let page: Page
let browser: { workspaceId: string; panelId: string }
const evaluate = (expression: string) => fixtureEvaluate(app, page, browser, expression)

async function saveCapture(testInfo: TestInfo, name: string, png: Buffer): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await writeFile(path, png)
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

async function recordNativeCapture(guestId: number | null): Promise<void> {
  await app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id!)! as any
    const capture = guest.capturePage.bind(guest)
    guest.capturePage = async (...args: unknown[]) => {
      const image = await capture(...args)
      guest.__cateLastNativeCapture = image
      return image
    }
  }, guestId)
}

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const html = `<title>Action reliability</title>
    <textarea id="multiline" aria-label="Multiline">firstsecond</textarea><input id="name" aria-label="Name" value="abcdef"><input id="readonly" aria-label="Readonly" readonly value="original">
    <input id="disabled" aria-label="Disabled input" disabled value="original">
    <div id="editor" role="textbox" aria-label="Editor" contenteditable><b>bold</b> tail</div>
    <button id="covered" style="position:absolute;left:20px;top:160px;width:100px;height:40px">Covered</button>
    <div id="overlay" style="position:absolute;left:20px;top:160px;width:100px;height:40px;z-index:1" onclick="document.body.dataset.wrongClick='yes'"></div>
    <button id="disabledButton" disabled>Disabled button</button>
    <input id="cancelCheck" aria-label="Cancelled checkbox" type="checkbox" onclick="event.preventDefault()">
    <div id="swatch" role="img" aria-label="Swatch" style="position:absolute;top:250px;left:20px;width:180px;height:80px;background:rgb(20,180,70)"></div>
    <button id="offscreen" style="position:absolute;top:3000px;width:180px;height:80px;background:rgb(20,180,70);color:rgb(20,180,70);border:0;padding:0">Offscreen</button>`
  browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 120, y: 120 }), `data:text/html,${encodeURIComponent(html)}`)
  await expect.poll(() => page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId), { timeout: 20_000 }).not.toBeNull()
  await target(page, browser, 'Name')
})
test.afterEach(async () => { if (app) await closeApp(app) })

test('typing replaces input selection and preserves rich text outside the selection', async () => {
  expect(await act(page, browser, 'selectText', 'Name', { text: 'cd', selectionType: 'text' })).toMatchObject({ ok: true })
  expect(await activeAction(page, browser, 'typeText', { text: 'XY' })).toMatchObject({ ok: true })
  expect(await evaluate(`document.querySelector('#name').value`)).toBe('abXYef')
  expect(await act(page, browser, 'selectText', 'Editor', { text: 'tail', selectionType: 'text' })).toMatchObject({ ok: true })
  expect(await activeAction(page, browser, 'typeText', { text: 'new' })).toMatchObject({ ok: true })
  expect(await evaluate(`document.querySelector('#editor').innerHTML`)).toBe('<b>bold</b> new')
})

test('setValue rejects readonly and disabled controls without changing their values', async () => {
  for (const [id, name] of [['readonly', 'Readonly'], ['disabled', 'Disabled input']]) {
    expect(await act(page, browser, 'setValue', name, { value: 'changed' })).toMatchObject({ ok: false })
    expect(await evaluate(`document.querySelector('#${id}').value`)).toBe('original')
  }
})

test('click rejects obstructed and disabled targets without clicking the obstruction', async () => {
  expect(await act(page, browser, 'click', 'Covered')).toMatchObject({ ok: false })
  expect(await evaluate(`document.body.dataset.wrongClick ?? null`)).toBeNull()
  expect(await act(page, browser, 'click', 'Disabled button')).toMatchObject({ ok: false })
})

test('setChecked reports a failed checked-state postcondition', async () => {
  expect(await act(page, browser, 'setChecked', 'Cancelled checkbox', { checked: true })).toMatchObject({ ok: false })
  expect(await evaluate(`document.querySelector('#cancelCheck').checked`)).toBe(false)
})

test('paired observations and native screenshots preserve scroll and renderer focus at browser zoom', async () => {
  const testInfo = test.info()
  const rendererFocusTarget = page.getByRole('button', { name: /Select tool/ })
  await rendererFocusTarget.focus()
  const guestId = await page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId)
  await recordNativeCapture(guestId)
  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ webContents }, { id, zoom }) => webContents.fromId(id!)!.setZoomFactor(zoom), { id: guestId, zoom })
    const before = await evaluate('scrollY')
    const observation = await observe(page, browser, true)
    expect(observation.elements.find((item) => item.name === 'Offscreen')?.offscreen).toBe(true)
    expect(observation.viewport.scrollY).toBe(before)
    const screenshot = observation.screenshot!
    expect(screenshot.mimeType).toBe('image/png')
    const { data, info } = await sharp(Buffer.from(screenshot.data, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(screenshot.width)
    expect(info.height).toBe(screenshot.height)
    const scale = info.width / observation.viewport.width
    const center = (Math.floor(290 * scale) * info.width + Math.floor(110 * scale)) * info.channels
    const sample = [...data.subarray(center, center + info.channels)]
    await saveCapture(testInfo, `native-viewport-zoom-${zoom}`, Buffer.from(screenshot.data, 'base64'))
    if ([20, 180, 70].some((expected, channel) => Math.abs(sample[channel] - expected) > 5)) {
      const native = await app.evaluate(({ webContents }, id) => (webContents.fromId(id!)! as any).__cateLastNativeCapture.toPNG().toString('base64'), guestId)
      await saveCapture(testInfo, `original-native-zoom-${zoom}`, Buffer.from(native, 'base64'))
    }
    // Native capture passes through the display color profile.
    for (const [channel, expected] of [20, 180, 70].entries()) expect(Math.abs(data[center + channel] - expected), JSON.stringify({ zoom, viewport: observation.viewport, info, sample })).toBeLessThanOrEqual(5)
    await expect(rendererFocusTarget).toBeFocused()
    expect(await evaluate('scrollY')).toBe(before)
  }
  const scrollResult = await activeAction(page, browser, 'scroll', { target: [400, 350], direction: 'down', pages: 8 })
  expect(scrollResult, JSON.stringify(scrollResult)).toMatchObject({ ok: true })
  await expect.poll(() => evaluate('scrollY')).toBeGreaterThan(0)
  const before = await evaluate('scrollY')
  expect(await browserInvoke(page, browser, 'getScreenshot')).toMatchObject({ ok: true })
  expect(await evaluate('scrollY')).toBe(before)
})

test('Return inserts a newline at the textarea selection', async () => {
  expect(await act(page, browser, 'selectText', 'Multiline', { text: 'second', selectionType: 'cursor_before' })).toMatchObject({ ok: true })
  expect(await activeAction(page, browser, 'pressKey', { key: 'Return' })).toMatchObject({ ok: true })
  expect(await evaluate(`document.querySelector('#multiline').value`)).toBe('first\nsecond')
})

test('paired screenshots stay fresh across alternating zoom and page generations', async () => {
  const testInfo = test.info()
  const rendererFocusTarget = page.getByRole('button', { name: /Select tool/ })
  await rendererFocusTarget.focus()
  const guestId = await page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId)
  // Keep the original native image for failure diagnostics before runtime
  // resizing; encoding it only on failure avoids adding a paint-settle delay.
  await recordNativeCapture(guestId)
  const before = await evaluate('scrollY')
  for (let generation = 0; generation < 12; generation++) {
    const zoom = generation % 2 ? 1.25 : 1
    const rgb = [30 + generation * 13, 190 - generation * 9, 60 + generation * 11]
    await app.evaluate(async ({ webContents }, { id, zoom, generation, rgb }) => {
      const guest = webContents.fromId(id!)!
      guest.setZoomFactor(zoom)
      await guest.executeJavaScript(`(() => {
        const swatch = document.querySelector('#swatch');
        swatch.style.backgroundColor = 'rgb(${rgb.join(',')})';
        swatch.setAttribute('aria-label', 'Swatch generation ${generation}');
      })()`)
    }, { id: guestId, zoom, generation, rgb })
    const observation = await observe(page, browser, true)
    const screenshot = observation.screenshot!
    const { data, info } = await sharp(Buffer.from(screenshot.data, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const center = (290 * info.width + 110) * info.channels
    const sample = [...data.subarray(center, center + info.channels)]
    try {
      expect(observation.elements.some((item) => item.name === `Swatch generation ${generation}`)).toBe(true)
      expect(info.width).toBe(Math.round(observation.viewport.width))
      expect(info.height).toBe(Math.round(observation.viewport.height))
      for (const [channel, expected] of rgb.entries()) expect(Math.abs(sample[channel] - expected), JSON.stringify({ generation, zoom, viewport: observation.viewport, sample, rgb })).toBeLessThanOrEqual(5)
      expect(observation.viewport.scrollY).toBe(before)
      await expect(rendererFocusTarget).toBeFocused()
    } catch (error) {
      await saveCapture(testInfo, `generation-${generation}-output`, Buffer.from(screenshot.data, 'base64'))
      const original = await app.evaluate(({ webContents }, id) => {
        const image = (webContents.fromId(id!)! as any).__cateLastNativeCapture
        return { size: image.getSize(), png: image.toPNG().toString('base64') }
      }, guestId)
      await saveCapture(testInfo, `generation-${generation}-native`, Buffer.from(original.png, 'base64'))
      await testInfo.attach('capture-metadata', { body: JSON.stringify({ generation, zoom, viewport: observation.viewport, nativeSize: original.size, sample, rgb }), contentType: 'application/json' })
      throw error
    }
  }
  expect(await evaluate('scrollY')).toBe(before)
})

test('coordinate actions reject observations made before the viewport changes', async () => {
  const observation = await observe(page, browser, true)
  expect(await browserInvoke(page, browser, 'setViewport', { width: 390, height: 844 })).toMatchObject({ ok: true })
  expect(await browserInvoke(page, browser, 'click', { observationId: observation.observationId, target: [40, 40] })).toMatchObject({ ok: false })
  expect(await evaluate(`document.body.dataset.wrongClick ?? null`)).toBeNull()
})

test('actions return changed state while IDs remain stable within one document', async () => {
  const initial = await observe(page, browser)
  const name = initial.elements.find((element) => element.name === 'Name' && element.role === 'textbox')!
  const result = await browserInvoke(page, browser, 'setValue', { observationId: initial.observationId, target: name.id, value: 'changed' })
  expect(result).toMatchObject({ ok: true, result: {
    action: { method: 'setValue', status: 'verified' },
    observation: { documentId: initial.documentId, diff: true, elements: expect.arrayContaining([
      expect.objectContaining({ id: name.id, name: 'Name', value: 'changed' }),
    ]) },
  } })
  const after = await observe(page, browser)
  expect(after.observationId).not.toBe(initial.observationId)
  expect(after.elements.find((element) => element.name === 'Name' && element.role === 'textbox')?.id).toBe(name.id)
  expect(await evaluate(`document.querySelector('#name').value`)).toBe('changed')
})

test('typing follows current focus after a prior observation', async () => {
  await evaluate("document.querySelector('#name').focus()")
  const prior = await observe(page, browser)
  await evaluate("document.querySelector('#multiline').focus()")
  expect(await browserInvoke(page, browser, 'typeText', { observationId: prior.observationId, text: 'HELLO' })).toMatchObject({ ok: true })
  expect(await evaluate("document.querySelector('#name').value")).toBe('abcdef')
  expect(await evaluate("document.querySelector('#multiline').value")).toContain('HELLO')
})

for (const destination of ['closed-shadow', 'frame']) {
  test(`typing follows focus into a ${destination} after a prior observation`, async () => {
    await evaluate("document.querySelector('#name').focus()")
    const prior = await observe(page, browser)
    await evaluate(destination === 'closed-shadow' ? `(() => {
      const host=document.createElement('div');document.body.append(host);
      const root=host.attachShadow({mode:'closed'});root.innerHTML='<input aria-label="New focus">';
      window.focusTarget=root.querySelector('input');window.focusTarget.focus();
    })()` : `new Promise(resolve => {
      const frame=document.createElement('iframe');
      frame.onload=()=>{window.focusTarget=frame.contentDocument.querySelector('input');window.focusTarget.focus();resolve(true);};
      frame.srcdoc='<input aria-label="New focus">';document.body.append(frame);
    })`)
    expect(await browserInvoke(page, browser, 'typeText', { observationId: prior.observationId, text: 'HELLO' })).toMatchObject({ ok: true })
    expect(await evaluate("document.querySelector('#name').value")).toBe('abcdef')
    expect(await evaluate('window.focusTarget.value')).toBe('HELLO')
  })
}
