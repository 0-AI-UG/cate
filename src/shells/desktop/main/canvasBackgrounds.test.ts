import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { createCanvasBackgrounds } from './canvasBackgrounds'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-shell-bg-'))
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-shell-bg-src-'))
const bgDir = path.join(userData, 'canvas-backgrounds')
const backgrounds = createCanvasBackgrounds(bgDir)

const writeSrc = (name: string, bytes: string): string => {
  const p = path.join(src, name)
  fs.writeFileSync(p, bytes)
  return p
}

beforeEach(() => { fs.rmSync(bgDir, { recursive: true, force: true }) })
afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(src, { recursive: true, force: true })
})

describe('canvas backgrounds', () => {
  test('copies a picked image into canvas-backgrounds/', async () => {
    const managed = await backgrounds.importImage(writeSrc('wall.PNG', 'PNGDATA'))
    expect(path.dirname(managed)).toBe(bgDir)
    expect(path.extname(managed)).toBe('.png')
    expect(fs.readFileSync(managed, 'utf-8')).toBe('PNGDATA')
  })

  test('is idempotent for identical contents', async () => {
    const source = writeSrc('wall.png', 'SAME')
    expect(await backgrounds.importImage(source)).toBe(await backgrounds.importImage(source))
    expect(fs.readdirSync(bgDir)).toHaveLength(1)
  })

  test('keeps the original path for an unsupported type', async () => {
    const source = writeSrc('notes.txt', 'nope')
    expect(await backgrounds.importImage(source)).toBe(source)
    expect(fs.existsSync(bgDir)).toBe(false)
  })

  test('prunes every copy but the kept one', async () => {
    const keep = await backgrounds.importImage(writeSrc('a.png', 'AAA'))
    await backgrounds.importImage(writeSrc('b.jpg', 'BBB'))
    backgrounds.prune(keep)
    expect(fs.readdirSync(bgDir)).toEqual([path.basename(keep)])
    backgrounds.prune('')
    expect(fs.readdirSync(bgDir)).toHaveLength(0)
  })

  test('reads wallpapers as data URLs and refuses other files', async () => {
    const managed = await backgrounds.importImage(writeSrc('c.webp', 'WEBP'))
    expect(await backgrounds.read(managed)).toBe(`data:image/webp;base64,${Buffer.from('WEBP').toString('base64')}`)
    expect(await backgrounds.read(writeSrc('secret.txt', 'x'))).toBeNull()
    expect(await backgrounds.read(path.join(src, 'missing.png'))).toBeNull()
  })
})
