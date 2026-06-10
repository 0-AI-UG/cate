import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeTextAtomic,
  writeTextAtomicSync,
} from './writeJsonAtomic'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-writejson-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('writes pretty JSON with a trailing newline by default', async () => {
    const p = path.join(dir, 'a.json')
    await writeJsonAtomic(p, { b: 1, a: 2 })
    const raw = fs.readFileSync(p, 'utf-8')
    expect(raw).toBe('{\n  "b": 1,\n  "a": 2\n}\n')
    expect(JSON.parse(raw)).toEqual({ b: 1, a: 2 })
  })

  it('writes compact JSON when pretty:false', async () => {
    const p = path.join(dir, 'c.json')
    await writeJsonAtomic(p, { x: 1 }, { pretty: false })
    expect(fs.readFileSync(p, 'utf-8')).toBe('{"x":1}')
  })

  it('creates missing parent directories', async () => {
    const p = path.join(dir, 'nested', 'deep', 'd.json')
    await writeJsonAtomic(p, [1, 2, 3])
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual([1, 2, 3])
  })

  it('leaves no .tmp file behind on success', async () => {
    const p = path.join(dir, 'e.json')
    await writeJsonAtomic(p, { ok: true })
    expect(fs.existsSync(p + '.tmp')).toBe(false)
  })

  it('applies a secret file mode when requested', async function () {
    if (process.platform === 'win32') return // no POSIX file modes
    const p = path.join(dir, 'secret.json')
    await writeJsonAtomic(p, { token: 's' }, { mode: 0o600 })
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
  })

  it('overwrites an existing file atomically (final content replaces old)', async () => {
    const p = path.join(dir, 'f.json')
    await writeJsonAtomic(p, { v: 1 })
    await writeJsonAtomic(p, { v: 2 })
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ v: 2 })
  })

  it('sync variant matches the async serialization byte-for-byte', () => {
    const p1 = path.join(dir, 's1.json')
    writeJsonAtomicSync(p1, { a: 1, b: [2, 3] })
    expect(fs.readFileSync(p1, 'utf-8')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n')
  })

  it('writeTextAtomic writes raw text verbatim (no JSON re-encoding)', async () => {
    const p = path.join(dir, 'auth.json')
    await writeTextAtomic(p, '{}\n', { mode: 0o600 })
    expect(fs.readFileSync(p, 'utf-8')).toBe('{}\n')
  })

  it('writeTextAtomicSync writes raw text verbatim', () => {
    const p = path.join(dir, 'raw.txt')
    writeTextAtomicSync(p, 'hello world')
    expect(fs.readFileSync(p, 'utf-8')).toBe('hello world')
  })

  it('concurrent writes to the same path do not corrupt via a shared tmp', async () => {
    const p = path.join(dir, 'concurrent.json')
    // A fixed `<file>.tmp` would let one write consume the tmp while another's
    // rename races it, ending in ENOENT or an interleaved/corrupt file. With
    // per-write unique tmp names every rename is independent.
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(p, { i })))
    // Exactly one valid final file, parseable, and no orphaned tmp files remain.
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(typeof parsed.i).toBe('number')
    expect(parsed.i).toBeGreaterThanOrEqual(0)
    expect(parsed.i).toBeLessThan(20)
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('each write uses a distinct tmp name (no fixed <file>.tmp collision)', async () => {
    const p = path.join(dir, 'unique.json')
    const seen = new Set<string>()
    // Spy on rename to capture the tmp filename each write hands off.
    const realRename = fs.promises.rename.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      seen.add(String(from))
      return realRename(from, to)
    })
    try {
      await Promise.all(Array.from({ length: 5 }, (_, i) => writeJsonAtomic(p, { i })))
    } finally {
      spy.mockRestore()
    }
    expect(seen.size).toBe(5) // five distinct tmp paths, none equal to <file>.tmp
    expect([...seen].some((f) => f === p + '.tmp')).toBe(false)
  })

  it('retries transient EPERM renames on win32 (concurrent replace race)', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const realRename = fs.promises.rename.bind(fs.promises)
    let failuresLeft = 2
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (failuresLeft-- > 0) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return realRename(from, to)
    })
    try {
      const p = path.join(dir, 'retry.json')
      await writeJsonAtomic(p, { ok: 1 })
      expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ ok: 1 })
      expect(spy).toHaveBeenCalledTimes(3)
    } finally {
      spy.mockRestore()
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
