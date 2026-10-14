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
      { target: { kind: 'file', path: '/repo/src/a.ts', line: 2 }, text: 'src/a.ts:2', start: { x: 4, row: 1 }, end: { x: 14, row: 1 } },
    ])
    expect(await screen.links({ row: 1, text: 'see src/b.ts:2' }, '/repo', isFile)).toEqual([])
    expect(await screen.links({ row: 9, text: '' }, '/repo', isFile)).toEqual([])
    screen.dispose()
  })
})
