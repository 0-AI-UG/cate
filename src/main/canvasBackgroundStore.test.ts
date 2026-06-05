// =============================================================================
// canvasBackgroundStore — copy-into-userData import + orphan pruning.
// =============================================================================

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-bg-test-'))
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-bg-src-'))

vi.mock('electron', () => {
  const electron = { app: { getPath: () => userData } }
  return { ...electron, default: electron }
})
vi.mock('./logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))

const { importCanvasBackgroundImage, pruneCanvasBackgrounds } = await import('./canvasBackgroundStore')

const bgDir = path.join(userData, 'canvas-backgrounds')
const writeSrc = (name: string, bytes: string): string => {
  const p = path.join(src, name)
  fs.writeFileSync(p, bytes)
  return p
}

beforeEach(() => {
  try { fs.rmSync(bgDir, { recursive: true, force: true }) } catch { /* noop */ }
})
afterAll(() => {
  for (const d of [userData, src]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* noop */ } }
})

describe('importCanvasBackgroundImage', () => {
  test('copies the image into managed app data and returns the managed path', async () => {
    const source = writeSrc('wall.png', 'PNGDATA')
    const managed = await importCanvasBackgroundImage(source)
    expect(path.dirname(managed)).toBe(bgDir)
    expect(path.extname(managed)).toBe('.png')
    expect(fs.readFileSync(managed, 'utf-8')).toBe('PNGDATA')
  })

  test('is idempotent for identical contents (no duplicate copies)', async () => {
    const source = writeSrc('wall.png', 'SAME')
    const a = await importCanvasBackgroundImage(source)
    const b = await importCanvasBackgroundImage(source)
    expect(a).toBe(b)
    expect(fs.readdirSync(bgDir)).toHaveLength(1)
  })

  test('falls back to the original path for an unsupported extension', async () => {
    const source = writeSrc('notes.txt', 'nope')
    const managed = await importCanvasBackgroundImage(source)
    expect(managed).toBe(source)
    expect(fs.existsSync(bgDir)).toBe(false)
  })
})

describe('pruneCanvasBackgrounds', () => {
  test('deletes every managed copy except the one to keep', async () => {
    const keep = await importCanvasBackgroundImage(writeSrc('a.png', 'AAA'))
    await importCanvasBackgroundImage(writeSrc('b.jpg', 'BBB'))
    expect(fs.readdirSync(bgDir)).toHaveLength(2)
    pruneCanvasBackgrounds(keep)
    expect(fs.readdirSync(bgDir)).toEqual([path.basename(keep)])
  })

  test('clears the directory when nothing should be kept', async () => {
    await importCanvasBackgroundImage(writeSrc('a.png', 'AAA'))
    pruneCanvasBackgrounds('')
    expect(fs.readdirSync(bgDir)).toHaveLength(0)
  })
})
