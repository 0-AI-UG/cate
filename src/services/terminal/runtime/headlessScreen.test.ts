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
