// Connected panel context reaching a terminal agent end to end: a Claude Code
// stand-in (fixtures/fake-claude.cjs) runs in a real Cate terminal connected
// to a browser panel and runs whatever hooks Cate installed for it. With the
// hooks, a typed prompt and `cate agent send` both carry the context once;
// without them, or under an agent that cannot take context (Cursor), the
// context chip warns and nothing is sent.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { closeApp, expectTerminalText, makeHome, makeProject, seedOnCanvas } from './fixtures/electron-app'
import { launchWithRuntime } from './fixtures/runtime-install'
import { cate, runInTerminal, shellQuote } from './fixtures/cate-terminal'

test.skip(process.platform === 'win32', 'the stand-in is started through a POSIX symlink')

let app: ElectronApplication
let page: Page
let home: string
let workspace: string
let out: string

test.beforeEach(async () => {
  home = makeHome()
  workspace = realpathSync(makeProject(home, { git: true }))
  out = path.join(home, 'fake-claude.jsonl')
  mkdirSync(path.join(home, 'bin'))
  ;({ electronApp: app, mainWindow: page } = await launchWithRuntime({ home, workspace }))
})
test.afterEach(async () => closeApp(app, { home }))

type Turn = { prompt: string; context: string | null }
const turns = (): Turn[] => existsSync(out)
  ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Turn)
  : []
const chip = () => page.getByRole('button', { name: /connected panels/ })

/** A terminal connected to a browser panel, running the stand-in under the
 *  agent's process name. */
async function startConnectedAgent(expectHooks: boolean, name = 'claude'): Promise<string> {
  const binary = path.join(home, 'bin', name)
  symlinkSync(process.execPath, binary)
  const terminal = (await seedOnCanvas(page, 'terminal', { x: 80, y: 80 })).panelId
  const browser = (await seedOnCanvas(page, 'browser', { x: 900, y: 80 })).panelId
  await page.evaluate(({ from, to }) => window.__cateE2E!.propose({
    kind: 'addRelation',
    relation: { id: crypto.randomUUID(), fromPanelId: from, toPanelId: to, kind: 'use' },
  }), { from: terminal, to: browser })
  await expectTerminalText(page, terminal, /\S/)
  const fixture = path.resolve(__dirname, 'fixtures/fake-claude.cjs')
  const command = `${shellQuote(binary)} ${shellQuote(fixture)} ${shellQuote(out)}\r`
  await page.evaluate(({ id, command }) => window.__cateE2E!.writeTerminal(id, command), { id: terminal, command })
  await expectTerminalText(page, terminal, `FAKE_CLAUDE_READY hooks=${expectHooks}`, { timeout: 20_000 })
  return terminal
}

async function typePrompt(terminal: string, prompt: string): Promise<void> {
  const before = turns().length
  await page.evaluate(({ id, data }) => window.__cateE2E!.writeTerminal(id, data), { id: terminal, data: `${prompt}\r` })
  await expect.poll(() => turns().length, { timeout: 20_000 }).toBe(before + 1)
}

test('an agent without Cate hooks gets a warning on the context chip and no context', async () => {
  const terminal = await startConnectedAgent(false)
  await expect(chip()).toHaveAccessibleName(/not sent: Hooks off/, { timeout: 20_000 })
  await expect(chip()).toContainText('Hooks off')
  await typePrompt(terminal, 'hello')
  expect(turns()).toEqual([{ prompt: 'hello', context: null }])
})

test('an agent that cannot take context gets a warning on the context chip', async () => {
  const terminal = await startConnectedAgent(false, 'cursor-agent')
  await expect(chip()).toHaveAccessibleName(/not sent: Not supported/, { timeout: 20_000 })
  await typePrompt(terminal, 'hello')
  expect(turns()).toEqual([{ prompt: 'hello', context: null }])
})

test('with Cate hooks a typed prompt carries the context once', async () => {
  await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'agentHookInjection', value: { 'claude-code': 'on' } }))
  const terminal = await startConnectedAgent(true)
  await expect(chip()).toHaveAccessibleName(/next message/, { timeout: 20_000 })
  await typePrompt(terminal, 'first')
  await typePrompt(terminal, 'second')
  const [first, second] = turns()
  expect(first.context).toContain('Browser')
  expect(second).toEqual({ prompt: 'second', context: null })
  await expect(chip()).toHaveAccessibleName(/off/)
})

test('cate agent send carries a one-shot context to the agent', async () => {
  await page.evaluate(() => window.__cateE2E!.call('settings', 'set', { key: 'agentHookInjection', value: { 'claude-code': 'on' } }))
  const terminal = await startConnectedAgent(true)
  const control = (await seedOnCanvas(page, 'terminal', { x: 80, y: 900 })).panelId
  await expect.poll(() => page.evaluate((id) => window.__cateE2E!.call('agents', 'panel', { panelId: id }), terminal), { timeout: 20_000 })
    .toMatchObject({ agentId: 'claude-code', canReceivePrompt: true })
  const result = await runInTerminal(page, control, cate('agent', 'send', '--panel', terminal, 'sent prompt'))
  expect(result.code, result.output).toBe(0)
  await expect.poll(() => turns().length, { timeout: 20_000 }).toBe(1)
  expect(turns()[0].prompt).toBe('sent prompt')
  expect(turns()[0].context).toContain('Browser')
})
