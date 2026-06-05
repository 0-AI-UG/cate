// =============================================================================
// jsonStateFile — load/normalize, atomic write, corrupt-file quarantine.
// =============================================================================

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-jsonstate-test-'))

vi.mock('electron', () => {
  const electron = { app: { getPath: () => userData } }
  return { ...electron, default: electron }
})
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))
vi.mock('./logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))

const { createJsonStateFile } = await import('./jsonStateFile')

interface Shape { items: string[] }
const defaults: Shape = { items: [] }
const normalize = (parsed: unknown, d: Shape): Shape => {
  const o = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  return { items: Array.isArray(o.items) ? o.items.filter((x): x is string => typeof x === 'string') : d.items }
}

function cleanup() {
  for (const f of fs.readdirSync(userData)) fs.rmSync(path.join(userData, f), { force: true })
}

beforeEach(cleanup)
afterAll(() => { try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ } })

describe('jsonStateFile', () => {
  test('absent file loads defaults', () => {
    const store = createJsonStateFile({ filename: 'a.json', defaults, normalize })
    expect(store.get()).toEqual({ items: [] })
  })

  test('set + sync flush writes pretty-printed JSON that reloads', () => {
    const store = createJsonStateFile({ filename: 'b.json', defaults, normalize })
    store.set({ items: ['x', 'y'] })
    store.flushPendingWritesSync()
    const raw = fs.readFileSync(path.join(userData, 'b.json'), 'utf-8')
    expect(raw).toBe(JSON.stringify({ items: ['x', 'y'] }, null, 2) + '\n')
    // A fresh instance reads it back through normalize.
    const reopened = createJsonStateFile({ filename: 'b.json', defaults, normalize })
    expect(reopened.get()).toEqual({ items: ['x', 'y'] })
  })

  test('normalize drops unknown/ill-typed fields', () => {
    fs.writeFileSync(path.join(userData, 'c.json'), JSON.stringify({ items: ['ok', 3, null], extra: 1 }))
    const store = createJsonStateFile({ filename: 'c.json', defaults, normalize })
    expect(store.get()).toEqual({ items: ['ok'] })
  })

  test('corrupt file is quarantined and falls back to defaults', () => {
    fs.writeFileSync(path.join(userData, 'd.json'), '{ not valid json,,,')
    const store = createJsonStateFile({ filename: 'd.json', defaults, normalize })
    expect(store.get()).toEqual({ items: [] })
    const backups = fs.readdirSync(userData).filter((f) => f.startsWith('d.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(fs.readFileSync(path.join(userData, backups[0]), 'utf-8')).toContain('not valid json')
  })

  test('update applies a functional change', () => {
    const store = createJsonStateFile({ filename: 'e.json', defaults, normalize })
    store.set({ items: ['a'] })
    store.update((cur) => ({ items: [...cur.items, 'b'] }))
    expect(store.get()).toEqual({ items: ['a', 'b'] })
  })
})
