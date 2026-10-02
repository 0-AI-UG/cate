// Shared workspace, chat panel (T3 Code) against the deterministic fake
// harness the runtime starts (fixtures/fake-t3.cjs): one harness on the
// runtime's loopback, both clients load it; thread binding and the panel's
// open ops made by one client show in the other.

import { test, expect } from '@playwright/test'
import type { Locator } from 'playwright'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { activeCanvasId, describeShared, doc, sessionOp, sessionOpError, seedShared, snapshot, type SharedClient } from '../fixtures/shared-workspace'

type ChatSnapshot = { phase: string; threadId: string | null; loadId: number; harness: { origin: string } | null; checkout: string }
const chat = (c: SharedClient, id: string) => snapshot<ChatSnapshot>(c, id)

const guest = (c: SharedClient, panelId: string): Locator => c.page.locator(`webview[data-chat-webview="${panelId}"]`)
const guestEval = <T>(c: SharedClient, panelId: string, source: string): Promise<T> =>
  guest(c, panelId).evaluate((element, script) => (element as HTMLElement & { executeJavaScript(code: string): Promise<T> }).executeJavaScript(script), source)
const guestPath = (c: SharedClient, panelId: string) =>
  guest(c, panelId).evaluate((element) => {
    // Empty while the guest (re)loads.
    const url = (element as HTMLElement & { getURL(): string }).getURL()
    return url ? new URL(url).pathname : ''
  }).catch(() => '')

/** A fresh canvas node target on `c`'s active canvas. */
async function canvasTarget(c: SharedClient, origin: { x: number; y: number }) {
  const canvasId = await activeCanvasId(c)
  return { to: 'canvas', canvasId, nodeId: crypto.randomUUID(), stackId: crypto.randomUUID(), rect: { origin, size: { width: 600, height: 400 } } }
}

const newPanelsOfType = async (c: SharedClient, type: string, known: Set<string>) =>
  Object.values((await doc(c))?.panels ?? {}).filter((p) => p.type === type && !known.has(p.id)).map((p) => p.id)

describeShared('chat', (pair) => {
  let panelId: string

  test('a chat made in A loads the one harness in both clients', async () => {
    const { a, b } = pair()
    ;({ panelId } = await seedShared(pair(), a, 'chat', { x: 40, y: 40 }))
    for (const c of [a, b]) {
      await expect(guest(c, panelId)).toHaveAttribute('data-chat-guest-ready', 'true', { timeout: 45_000 })
      await expect.poll(async () => (await chat(c, panelId))?.phase, { timeout: 20_000 }).toBe('ready')
      expect(await guestEval<string>(c, panelId, 'document.title')).toBe('T3 Code')
    }
    expect((await chat(a, panelId))!.harness!.origin).toBe((await chat(b, panelId))!.harness!.origin)
  })

  test('a thread started in B binds the panel for A too', async () => {
    const { a, b } = pair()
    await guestEval(b, panelId, `(() => {
      document.querySelector('textarea[aria-label="Message"]').value = 'Shared prompt'
      document.querySelector('#composer').requestSubmit()
      return true
    })()`)
    for (const c of [a, b]) {
      await expect.poll(async () => (await chat(c, panelId))?.threadId, { timeout: 20_000 }).toBe('thread-e2e')
      await expect.poll(async () => (await doc(c))?.panels[panelId]?.fields.threadId).toBe('thread-e2e')
    }
  })

  test('A\'s page follows the thread B\'s page started', async () => {
    const { a } = pair()
    await expect.poll(() => guestPath(a, panelId), { timeout: 20_000 }).toBe('/e2e-env/thread-e2e')
  })

  test('selecting another thread from A moves B', async () => {
    const { a, b } = pair()
    expect(await sessionOp(a, panelId, { kind: 'selectThread', threadId: 'thread-existing' })).toBe(true)
    await expect.poll(async () => (await chat(b, panelId))?.threadId).toBe('thread-existing')
    await expect.poll(() => guestPath(b, panelId), { timeout: 20_000 }).toBe('/e2e-env/thread-existing')
    // A checkout that is not this panel's does not bind.
    expect(await sessionOp(b, panelId, { kind: 'selectThread', threadId: 'thread-x', checkout: '/elsewhere' })).toBe(false)
  })

  test('retry from B restarts the harness and reloads both clients', async () => {
    const { a, b } = pair()
    const before = (await chat(a, panelId))!.loadId
    await sessionOp(b, panelId, { kind: 'retry' })
    for (const c of [a, b]) {
      await expect.poll(async () => (await chat(c, panelId))?.loadId, { timeout: 30_000 }).toBeGreaterThan(before)
      await expect.poll(async () => (await chat(c, panelId))?.phase, { timeout: 30_000 }).toBe('ready')
    }
  })

  test('open ops from the chat create panels both clients see', async () => {
    const { a, b, project } = pair()
    writeFileSync(path.join(project, 'from-chat.ts'), 'export const fromChat = true\n')
    const known = new Set(Object.keys((await doc(a))!.panels))

    await sessionOp(b, panelId, { kind: 'openFile', path: 'from-chat.ts', at: await canvasTarget(b, { x: 1300, y: 40 }) })
    await expect.poll(() => newPanelsOfType(a, 'editor', known), { timeout: 20_000 }).toHaveLength(1)
    const [editorId] = await newPanelsOfType(a, 'editor', known)
    expect((await doc(a))!.panels[editorId!]!.fields.filePath).toBe(path.join(project, 'from-chat.ts'))

    await sessionOp(a, panelId, { kind: 'openChanges', at: await canvasTarget(a, { x: 1300, y: 900 }) })
    await expect.poll(() => newPanelsOfType(b, 'review', known), { timeout: 20_000 }).toHaveLength(1)

    await sessionOp(b, panelId, { kind: 'openChat', threadId: 'thread-e2e', title: 'Second chat', at: await canvasTarget(b, { x: 40, y: 900 }) })
    await expect.poll(() => newPanelsOfType(a, 'chat', known), { timeout: 20_000 }).toHaveLength(1)

    expect(await sessionOpError(a, panelId, { kind: 'openFile', path: '../outside.ts', at: await canvasTarget(a, { x: 0, y: 0 }) })).toBe('rejected')
  })

  test('an unbound chat refuses a rename from either client', async () => {
    const { a, b } = pair()
    await sessionOp(a, panelId, { kind: 'adoptThread', threadId: null })
    await expect.poll(async () => (await chat(b, panelId))?.threadId).toBeNull()
    expect(await sessionOpError(b, panelId, { kind: 'renameConversation', title: 'x' })).toBe('rejected')
  })
})
