import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installLogSink } from '../../log/contract'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-jsonstate-test-'))

vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))

const { createJsonStateFile } = await import('./jsonStateFile')
const { onQuarantine, quarantinedFiles } = await import('./quarantine')

interface Shape { items: string[] }
const defaults: Shape = { items: [] }
const normalize = (parsed: unknown, d: Shape): Shape => {
  const o = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  return { items: Array.isArray(o.items) ? o.items.filter((x): x is string => typeof x === 'string') : d.items }
}
const at = (name: string): string => path.join(dir, name)

beforeEach(() => {
  installLogSink(() => {})
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true })
})
afterAll(() => {
  installLogSink(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('jsonStateFile', () => {
  test('absent file loads defaults', () => {
    const store = createJsonStateFile({ file: at('a.json'), defaults, normalize })
    expect(store.get()).toEqual({ items: [] })
  })

  test('set + sync flush writes pretty-printed JSON that reloads', () => {
    const store = createJsonStateFile({ file: at('b.json'), defaults, normalize })
    store.set({ items: ['x', 'y'] })
    store.flushSync()
    expect(fs.readFileSync(at('b.json'), 'utf-8')).toBe(JSON.stringify({ items: ['x', 'y'] }, null, 2) + '\n')
    const reopened = createJsonStateFile({ file: at('b.json'), defaults, normalize })
    expect(reopened.get()).toEqual({ items: ['x', 'y'] })
  })

  test('normalize drops unknown/ill-typed fields', () => {
    fs.writeFileSync(at('c.json'), JSON.stringify({ items: ['ok', 3, null], extra: 1 }))
    const store = createJsonStateFile({ file: at('c.json'), defaults, normalize })
    expect(store.get()).toEqual({ items: ['ok'] })
  })

  test('corrupt file is quarantined and falls back to defaults', () => {
    fs.writeFileSync(at('d.json'), '{ not valid json,,,')
    const heard: string[] = []
    const off = onQuarantine(({ file }) => heard.push(file))
    const store = createJsonStateFile({ file: at('d.json'), defaults, normalize })
    expect(store.get()).toEqual({ items: [] })
    off()
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('d.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf-8')).toContain('not valid json')
    // The process's owner hears of it, to warn the person.
    expect(heard).toEqual([at('d.json')])
    expect(quarantinedFiles().at(-1)).toEqual({ file: at('d.json'), backup: path.join(dir, backups[0]) })
  })

  test('update applies a functional change', () => {
    const store = createJsonStateFile({ file: at('e.json'), defaults, normalize })
    store.set({ items: ['a'] })
    store.update((cur) => ({ items: [...cur.items, 'b'] }))
    expect(store.get()).toEqual({ items: ['a', 'b'] })
  })

  test('ensureFile writes defaults when the file is absent', async () => {
    const store = createJsonStateFile({ file: at('nested/f.json'), defaults, normalize })
    await store.ensureFile()
    expect(JSON.parse(fs.readFileSync(at('nested/f.json'), 'utf-8'))).toEqual(defaults)
  })

  test('secret files are written with the requested mode', async () => {
    const store = createJsonStateFile({ file: at('secret/s.json'), defaults, normalize, mode: 0o600 })
    store.set({ items: ['k'] })
    await store.flushDurable()
    if (process.platform !== 'win32') {
      expect(fs.statSync(at('secret/s.json')).mode & 0o777).toBe(0o600)
      expect(fs.statSync(at('secret')).mode & 0o777).toBe(0o700)
    }
  })
})

// Flush serialization and quit-flush correctness: async writes are gated by the
// test so overlapping flushes and an in-flight async flush are deterministic.
// The sync writer goes through to the real fs.

interface GatedWrite { path: string; content: string; release: () => void }

async function loadGatedStore(pending: GatedWrite[]) {
  vi.resetModules()
  vi.doMock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))
  vi.doMock('./atomicFile', async () => {
    const real = await vi.importActual<typeof import('./atomicFile')>('./atomicFile')
    return {
      ...real,
      writeJsonAtomic: (p: string, value: unknown) =>
        new Promise<void>((resolve) => {
          const content = JSON.stringify(value, null, 2) + '\n'
          pending.push({ path: p, content, release: () => { fs.writeFileSync(p, content, 'utf-8'); resolve() } })
        }),
    }
  })
  const mod = await import('./jsonStateFile')
  return mod.createJsonStateFile<Shape>({ file: at('flush.json'), defaults, normalize })
}

describe('jsonStateFile flush serialization', () => {
  test('overlapping flushes end with the newer content on disk and in memory', async () => {
    const pending: GatedWrite[] = []
    const store = await loadGatedStore(pending)
    vi.useFakeTimers()
    try {
      store.set({ items: ['old'] })
      await vi.advanceTimersByTimeAsync(200)
      store.set({ items: ['new'] })
      await vi.advanceTimersByTimeAsync(200)

      expect(pending.length).toBe(1)
      pending[0].release()
      await vi.runAllTimersAsync()
      expect(pending.length).toBe(2)
      pending[1].release()
      await vi.runAllTimersAsync()

      expect(JSON.parse(fs.readFileSync(at('flush.json'), 'utf-8'))).toEqual({ items: ['new'] })
      expect(store.get()).toEqual({ items: ['new'] })
    } finally {
      vi.useRealTimers()
    }
  })

  test('quit-flush during an in-flight async flush persists the latest value', async () => {
    const pending: GatedWrite[] = []
    const store = await loadGatedStore(pending)
    vi.useFakeTimers()
    try {
      store.set({ items: ['a', 'b'] })
      await vi.advanceTimersByTimeAsync(200)
      expect(pending.length).toBe(1)

      store.flushSync()

      expect(JSON.parse(fs.readFileSync(at('flush.json'), 'utf-8'))).toEqual({ items: ['a', 'b'] })
    } finally {
      vi.useRealTimers()
    }
  })
})
