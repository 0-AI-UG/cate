import { beforeEach, describe, expect, it, vi } from 'vitest'

const app = vi.hoisted(() => {
  const { EventEmitter: Emitter } = require('node:events') as typeof import('node:events')
  return Object.assign(new Emitter(), { quit: vi.fn() })
})
vi.mock('electron', () => ({ app, dialog: { showMessageBox: vi.fn() } }))

import { createQuitController, decideQuitPrompt } from './lifecycle'

const quitAttempt = () => {
  const event = { preventDefault: vi.fn() }
  app.emit('before-quit', event)
  return event
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('decideQuitPrompt', () => {
  it('quits right away without blockers or the warn setting', () => {
    expect(decideQuitPrompt({ warnBeforeQuit: false, blockers: [] })).toBeNull()
    expect(decideQuitPrompt({ warnBeforeQuit: true, blockers: [] })).toEqual({ message: 'Quit Cate?' })
  })

  it('names client-local work in progress', () => {
    expect(decideQuitPrompt({ warnBeforeQuit: false, blockers: ['Importing 3 files'] })?.message).toBe('Importing 3 files is still in progress. Quit anyway?')
    expect(decideQuitPrompt({ warnBeforeQuit: false, blockers: ['a', 'b'] })?.message).toBe('2 tasks are still in progress. Quit anyway?')
  })
})

describe('quit controller', () => {
  beforeEach(() => {
    app.removeAllListeners()
    app.quit.mockClear()
  })

  it('cleans up, then commits the quit', async () => {
    const beforeExit = vi.fn(async () => {})
    const quit = createQuitController({ warnBeforeQuit: () => false, blockers: () => [], parentWindow: () => undefined, beforeExit })
    quit.install()
    expect(quitAttempt().preventDefault).toHaveBeenCalled()
    await flush()
    expect(beforeExit).toHaveBeenCalledOnce()
    expect(quit.committed()).toBe(true)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(quitAttempt().preventDefault).not.toHaveBeenCalled()
  })

  it('a cancelled confirmation leaves the app running; a confirmed one quits', async () => {
    let answer = 1
    const showMessageBox = vi.fn(async () => ({ response: answer }))
    const beforeExit = vi.fn(async () => {})
    const quit = createQuitController({ warnBeforeQuit: () => false, blockers: () => ['Importing files'], parentWindow: () => undefined, beforeExit, showMessageBox })
    quit.install()
    quitAttempt()
    await flush()
    expect(app.quit).not.toHaveBeenCalled()
    expect(beforeExit).not.toHaveBeenCalled()
    answer = 0
    quitAttempt()
    await flush()
    expect(app.quit).toHaveBeenCalledOnce()
    quitAttempt()
    await flush()
    expect(showMessageBox).toHaveBeenCalledTimes(2)
    expect(beforeExit).toHaveBeenCalledOnce()
    expect(quit.committed()).toBe(true)
  })
})

