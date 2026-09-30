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
