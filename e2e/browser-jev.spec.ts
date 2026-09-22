import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp, seedTerminal } from './fixtures/electron-app'
import { fixtureEvaluate, target } from './fixtures/browser-control'

async function terminalCommand(page: Page, nodeId: string, command: string, marker: string) {
  const wrapped = process.platform === 'win32'
    ? `${command}; Write-Output ("${marker}:{0}" -f $LASTEXITCODE)\r`
    : `${command}; cate_status=$?; printf '\\n${marker}:%s\\n' "$cate_status"\r`
  expect(await page.evaluate(({ nodeId, wrapped }) => window.__cateE2E!.writeTerminal(nodeId, wrapped), { nodeId, wrapped })).toBe(true)
  await expect.poll(() => page.evaluate(({ nodeId, marker }) =>
    new RegExp(`${marker}:\\d+`).test(window.__cateE2E!.terminalText(nodeId) ?? ''), { nodeId, marker }), { timeout: 200_000 }).toBe(true)
  const text = await page.evaluate(nodeId => window.__cateE2E!.terminalText(nodeId), nodeId)
  return { code: Number(text!.match(new RegExp(`${marker}:(\\d+)`))![1]), text }
}

async function readyTerminal(page: Page) {
  const nodeId = await seedTerminal(page, { x: 100, y: 100 })
  await expect.poll(() => page.evaluate(id => window.__cateE2E!.terminalPtyId(id), nodeId), { timeout: 60_000 }).not.toBeNull()
  return nodeId
}

/** Only replace the external provider. CLI, host permissions, settings, and browser actions are real. */
async function mockDecisions(app: ElectronApplication, decisions: string[]) {
  await app.evaluate((_electron, decisions) => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'https://openrouter.ai/api/alpha/decisions') return originalFetch(input, init)
      if (new Headers(init?.headers).get('Authorization') !== 'Bearer test-saved-key') throw new Error('Saved key was not used')
      const request = JSON.parse(String(init?.body))
      const criteria = request.questions.decision.criteria
      const next = decisions.shift()!
      const choice = Object.hasOwn(criteria, next) ? next : Object.keys(criteria).find(key => criteria[key] === next)!
      return new Response(JSON.stringify({ answers: { decision: { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } } } }))
    }
  }, decisions)
}

for (const word of ['Hi', 'Hello!']) test(`Jev saves ${word} using the Cate setting without an exported key`, async () => {
  test.setTimeout(240_000)
  const live = process.env.CATE_LIVE_JEV === '1'
  if (live) expect(process.env.OPENROUTER_API_KEY).toBeTruthy()
  const { electronApp: app, mainWindow: page } = await launchApp({ env: { OPENROUTER_API_KEY: '' } })
  try {
    if (live) {
      await page.evaluate(key => window.electronAPI.settingsSet('cliOpenRouterApiKey', key), process.env.OPENROUTER_API_KEY!)
    } else {
      await page.evaluate(() => window.__cateE2E!.openSettings('cli'))
      const keyInput = page.getByLabel('OpenRouter API key', { exact: true })
      await expect(keyInput).toHaveAttribute('type', 'password')
      await keyInput.fill(' test-saved-key ')
      await keyInput.press('Enter')
      await expect.poll(() => page.evaluate(() => window.electronAPI.settingsGet('cliOpenRouterApiKey'))).toBe('test-saved-key')
      await page.keyboard.press('Escape')
      await mockDecisions(app, ['setValue', 'c0', word, 'click', 'c0', 'done'])
    }
    const html = `<title>Greeting form</title><label>Greeting <input id="greeting"></label>
      <button onclick="document.getElementById('result').textContent='Saved greeting: '+document.getElementById('greeting').value">Save</button><p id="result">Not saved yet</p>`
    const browser = await page.evaluate(url => window.__cateE2E!.createBrowser(url, { x: 120, y: 120 }), `data:text/html,${encodeURIComponent(html)}`)
    await target(page, browser, 'Greeting')
    const terminal = await readyTerminal(page)
    const result = await terminalCommand(page, terminal,
      `cate browser jev 'Set Greeting to ${word} then click Save. Finish when the saved greeting shows ${word}' --panel ${browser.panelId} --max-steps 5 --json`, '__JEV_SAVED')
    expect(result.code, result.text ?? '').toBe(0)
    expect(result.text).toContain('"status":"done"')
    expect(result.text).not.toContain('test-saved-key')
    expect(await fixtureEvaluate(app, page, browser, 'document.getElementById("greeting").value')).toBe(word)
    expect(await fixtureEvaluate(app, page, browser, 'document.getElementById("result").textContent')).toBe(`Saved greeting: ${word}`)
    await page.evaluate(() => window.electronAPI.settingsSet('cliOpenRouterApiKey', ''))
    const missing = await terminalCommand(page, terminal,
      `cate browser jev 'Verify the saved greeting' --panel ${browser.panelId} --json`, '__JEV_CLEARED')
    expect(missing.code).toBe(1)
    expect(missing.text).toContain('Set the OpenRouter API key in Cate Settings')
  } finally {
    await page.evaluate(() => window.electronAPI.settingsSet('cliOpenRouterApiKey', '')).catch(() => {})
    await closeApp(app)
  }
})

test('Jev completes Wikipedia search through the CLI with a saved key', async () => {
  test.skip(process.env.CATE_LIVE_JEV !== '1', 'Requires OpenRouter and public Wikipedia')
  test.setTimeout(240_000)
  expect(process.env.OPENROUTER_API_KEY).toBeTruthy()
  const { electronApp: app, mainWindow: page } = await launchApp({ env: { OPENROUTER_API_KEY: '' } })
  try {
    await page.evaluate(key => window.electronAPI.settingsSet('cliOpenRouterApiKey', key), process.env.OPENROUTER_API_KEY!)
    const browser = await page.evaluate(() => window.__cateE2E!.createBrowser('about:blank', { x: 120, y: 120 }))
    const terminal = await readyTerminal(page)
    const result = await terminalCommand(page, terminal,
      `cate browser jev 'Go to https://www.wikipedia.org and search for Berlin then submit the search. Finish when the Berlin article heading is visible.' --panel ${browser.panelId} --max-steps 15 --json`, '__JEV_WIKIPEDIA')
    expect(result.code, result.text ?? '').toBe(0)
    expect(result.text).toContain('"status":"done"')
    expect(await fixtureEvaluate(app, page, browser, 'document.querySelector("h1").textContent')).toBe('Berlin')
    expect(await fixtureEvaluate(app, page, browser, 'location.pathname')).toBe('/wiki/Berlin')
  } finally {
    await page.evaluate(() => window.electronAPI.settingsSet('cliOpenRouterApiKey', '')).catch(() => {})
    await closeApp(app)
  }
})
