import path from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { HeadlessScreen } from './headlessScreen'

async function settle(screen: HeadlessScreen): Promise<void> {
  await screen.settled()
}

describe('HeadlessScreen.read', () => {
  it('joins soft-wrapped rows into the line they continue', async () => {
    const screen = new HeadlessScreen(10, 5, 100)
    screen.write('abcde fghij klmno\r\nnext\r\n')
    await settle(screen)
    expect(screen.read().text).toBe('abcde fghij klmno\nnext')
    screen.dispose()
  })
})

describe('HeadlessScreen.capture', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('disables mouse tracking in a view attached after byte %i of the reset', async (split) => {
    const screen = new HeadlessScreen(80, 40, 100)
    const viewer = new Terminal({ cols: 80, rows: 40, allowProposedApi: true })
    const write = (data: string): Promise<void> => new Promise(resolve => viewer.write(data, resolve))
    const reset = '\x1b[?1003l'
    try {
      screen.write('\x1b[?1003h')
      await screen.settled()
      screen.write(reset.slice(0, split))
      await screen.settled()

      const capture = screen.capture()
      await write(capture.screen + capture.pending.join(''))
      expect(viewer.modes.mouseTrackingMode).toBe('any')

      const remaining = reset.slice(split) + 'shell prompt'
      screen.write(remaining)
      await write(remaining)
      await screen.settled()

      expect(viewer.modes.mouseTrackingMode).toBe('none')
      expect(viewer.buffer.active.getLine(0)?.translateToString(true)).toBe(screen.read().text)
    } finally {
      viewer.dispose()
      screen.dispose()
    }
  })

  it('carries at most the scrollback asked for above the screen', async () => {
    const screen = new HeadlessScreen(10, 2, 100)
    screen.write(Array.from({ length: 20 }, (_, i) => `line${i}`).join('\r\n'))
    await settle(screen)
    expect(screen.capture().screen).toContain('line0')
    const capped = screen.capture(3).screen
    expect(capped).not.toContain('line14')
    expect(capped).toContain('line15')
    expect(capped).toContain('line19')
    screen.dispose()
  })
})

describe('HeadlessScreen.links', () => {
  it('answers for a row counted up from the last line, when the view shows the same text', async () => {
    const screen = new HeadlessScreen(30, 3, 100)
    screen.write('a\r\nsee src/a.ts:2\r\nb')
    await settle(screen)
    const isFile = async () => true
    expect(await screen.links({ row: 1, text: 'see src/a.ts:2' }, '/repo', isFile)).toEqual([
      { target: { kind: 'file', path: path.resolve('/repo/src/a.ts'), line: 2 }, text: 'src/a.ts:2', start: { x: 4, row: 1 }, end: { x: 14, row: 1 } },
    ])
    expect(await screen.links({ row: 1, text: 'see src/b.ts:2' }, '/repo', isFile)).toEqual([])
    expect(await screen.links({ row: 9, text: '' }, '/repo', isFile)).toEqual([])
    screen.dispose()
  })
})
