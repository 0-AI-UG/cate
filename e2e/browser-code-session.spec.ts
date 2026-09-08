import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

let app: ElectronApplication
let directory: string

test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'cate-code-e2e-'))
  const output = path.join(directory, 'runner.cjs')
  await build({ entryPoints: ['src/main/browser/browserCodeSession.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], define: { __dirname: JSON.stringify(path.resolve('dist/main')) } })
  ;({ electronApp: app } = await launchApp())
  await app.evaluate(async (_electron, output) => {
    const { BrowserCodeSessions } = (process as any).mainModule.require(output)
    ;(globalThis as any).__codeSessions = new BrowserCodeSessions(1500)
  }, output)
})

test.afterEach(async () => {
  if (app) await closeApp(app)
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function cell(code: string, key = 'test') {
  return app.evaluate(async (_electron, { code, key }) => {
    return (globalThis as any).__codeSessions.run(key, code, async (method: string) => {
      if (method.endsWith('getTab')) return { panelId: 'p1', tabId: 't1' }
      return { panelId: 'p1', tabId: 't1', observationId: 'o1', documentId: 'd1', url: 'https://example.test', title: 'Fixture', viewport: { width: 1, height: 1 }, state: 'button "Save" [42]', elements: [{ id: 42, name: 'Save', role: 'button' }], diff: false,
        ...(method.includes('Screenshot') ? { screenshot: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', width: 1, height: 1 } } : {}),
      }
    })
  }, { code, key })
}

test('real sandbox supports persistent bindings and emits native images', async () => {
  const first = await cell('var tab = await cua.getTab({panelId:"p1"}); var answer = 41;')
  expect(first.isError, JSON.stringify(first)).toBeUndefined()
  expect(first.content[0].text).toContain('Save')
  const second = await cell('await nodeRepl.write(answer + 1); await tab.getAXStateAndScreenshot();')
  expect(second.isError, JSON.stringify(second)).toBeUndefined()
  expect(second.content[0]).toEqual({ type: 'text', text: '42' })
  expect(second.content[2]).toMatchObject({ type: 'image', mimeType: 'image/png' })
  expect(Buffer.from(second.content[2].data, 'base64').subarray(1, 4).toString()).toBe('PNG')
})

test('sandbox denies Node, scheduling, network, and cross-session bindings', async () => {
  expect((await cell('await nodeRepl.write([typeof process, typeof require, typeof setTimeout]);')).content[0].text).toBe('["undefined","undefined","undefined"]')
  const network = await cell('await fetch("https://example.com")')
  expect(network.isError).toBe(true)
  await cell('var privateBinding = "secret"')
  expect((await cell('await nodeRepl.write(typeof privateBinding)', 'other')).content[0].text).toBe('undefined')
})

test('timeout destroys code authority and clears persistent bindings', async () => {
  await cell('var staleBinding = 7')
  const timedOut = await cell('await new Promise(() => {})')
  expect(timedOut.isError).toBe(true)
  expect(JSON.stringify(timedOut)).toContain('timed out')
  expect((await cell('await nodeRepl.write(typeof staleBinding)')).content[0].text).toBe('undefined')
})
