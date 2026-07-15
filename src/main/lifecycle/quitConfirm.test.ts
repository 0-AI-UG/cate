import { describe, it, expect, vi, beforeEach } from 'vitest'

// quitConfirm pulls in electron + the settings/shell siblings at module load.
// Stub them so the module evaluates in a plain node test env, and keep the
// stubs mutable so each case can pick the running-terminal / setting state.
const state = vi.hoisted(() => ({
  warnBeforeQuit: false,
  running: [] as Array<{ processName: string | null }>,
  // Queued dialog answers, consumed in order: 0 = Quit, 1 = Cancel.
  responses: [] as number[],
  shown: [] as Array<{ parented: boolean; options: Record<string, unknown> }>,
}))

vi.mock('electron', () => {
  const dialog = {
    showMessageBox: (a: unknown, b?: unknown) => {
      const parented = b !== undefined
      state.shown.push({
        parented,
        options: (parented ? b : a) as Record<string, unknown>,
      })
      return Promise.resolve({ response: state.responses.shift() ?? 1 })
    },
  }
  const e = { dialog }
  return { ...e, default: e }
})
vi.mock('../settingsFile', () => ({ getSetting: () => state.warnBeforeQuit }))
vi.mock('../ipc/shell', () => ({ getRunningTerminals: () => state.running }))

const { decideQuitPrompt, guardQuit, isQuitCommitted, markQuitCommitted, resetQuitAttempt } =
  await import('./quitConfirm')

/** A stand-in for the live BrowserWindow the dialog would sheet onto. */
const fakeWin = { isDestroyed: () => false } as unknown as Electron.BrowserWindow

/** Let the dialog's promise chain settle (showMessageBox resolves immediately). */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  resetQuitAttempt()
  state.warnBeforeQuit = false
  state.running = []
  state.responses = []
  state.shown = []
})

describe('decideQuitPrompt', () => {
  it('does not prompt when nothing is running and warn-before-quit is off', () => {
    expect(decideQuitPrompt({ warnBeforeQuit: false, running: [] })).toBeNull()
  })

  it('prompts a plain quit confirmation when warn-before-quit is on', () => {
    const prompt = decideQuitPrompt({ warnBeforeQuit: true, running: [] })
    expect(prompt).not.toBeNull()
    expect(prompt!.message).toBe('Quit Cate?')
    expect(prompt!.detail).toBeUndefined()
  })

  it('warns about a single running terminal, naming the process', () => {
    const prompt = decideQuitPrompt({
      warnBeforeQuit: false,
      running: [{ processName: 'npm run dev' }],
    })
    expect(prompt!.message).toBe('“npm run dev” is still running. Quit anyway?')
    expect(prompt!.detail).toContain('process running in this terminal')
  })

  it('falls back to a generic message when the single process name is unknown', () => {
    const prompt = decideQuitPrompt({ warnBeforeQuit: false, running: [{ processName: null }] })
    expect(prompt!.message).toBe('A terminal is still running. Quit anyway?')
  })

  it('counts multiple running terminals', () => {
    const prompt = decideQuitPrompt({
      warnBeforeQuit: false,
      running: [{ processName: 'vim' }, { processName: 'top' }],
    })
    expect(prompt!.message).toBe('2 terminals are still running. Quit anyway?')
    expect(prompt!.detail).toContain('these terminals')
  })

  it('lets a running-terminal warning take precedence over the plain quit prompt', () => {
    const prompt = decideQuitPrompt({
      warnBeforeQuit: true,
      running: [{ processName: 'vim' }],
    })
    expect(prompt!.message).toContain('still running')
  })
})

describe('guardQuit', () => {
  it('proceeds without a dialog when there is nothing to confirm', () => {
    const event = { preventDefault: vi.fn() }
    const onConfirm = vi.fn()

    expect(guardQuit(event, fakeWin, onConfirm)).toBe('proceed')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(state.shown).toHaveLength(0)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('defers and prevents the action while a terminal is running', () => {
    state.running = [{ processName: 'claude' }]
    const event = { preventDefault: vi.fn() }

    expect(guardQuit(event, fakeWin, vi.fn())).toBe('deferred')
    // Prevented synchronously — the caller must not tear anything down.
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(state.shown).toHaveLength(1)
    expect(state.shown[0].options.buttons).toEqual(['Quit', 'Cancel'])
    expect(state.shown[0].options.cancelId).toBe(1)
  })

  // The regression this whole module exists for.
  it('Cancel does not run the action and does not latch — a later quit re-prompts', async () => {
    state.running = [{ processName: 'claude' }]
    state.responses = [1] // Cancel
    const onConfirm = vi.fn()

    guardQuit({ preventDefault: vi.fn() }, fakeWin, onConfirm)
    await settle()

    expect(onConfirm).not.toHaveBeenCalled()

    // A second quit attempt must ask again rather than sail through.
    state.responses = [1]
    expect(guardQuit({ preventDefault: vi.fn() }, fakeWin, onConfirm)).toBe('deferred')
    expect(state.shown).toHaveLength(2)
  })

  it('Quit runs the action and latches so later gates pass without re-prompting', async () => {
    state.running = [{ processName: 'claude' }]
    state.responses = [0] // Quit
    const onConfirm = vi.fn()

    guardQuit({ preventDefault: vi.fn() }, fakeWin, onConfirm)
    await settle()

    expect(onConfirm).toHaveBeenCalledOnce()

    // The replayed action re-enters the gate, and the app-level before-quit gate
    // follows it — neither may show a second dialog.
    const event = { preventDefault: vi.fn() }
    expect(guardQuit(event, fakeWin, vi.fn())).toBe('proceed')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(state.shown).toHaveLength(1)
  })

  it('does not latch when there was nothing to confirm', () => {
    // A quit with no terminals must not disarm the prompt for the rest of the
    // session — the app can outlive a quit attempt (Cancel at another gate).
    expect(guardQuit({ preventDefault: vi.fn() }, fakeWin, vi.fn())).toBe('proceed')

    state.running = [{ processName: 'claude' }]
    expect(guardQuit({ preventDefault: vi.fn() }, fakeWin, vi.fn())).toBe('deferred')
  })

  it('falls back to an app-modal dialog when there is no live parent window', () => {
    state.running = [{ processName: 'claude' }]

    guardQuit({ preventDefault: vi.fn() }, null, vi.fn())
    expect(state.shown[0].parented).toBe(false)

    resetQuitAttempt()
    const dead = { isDestroyed: () => true } as unknown as Electron.BrowserWindow
    guardQuit({ preventDefault: vi.fn() }, dead, vi.fn())
    expect(state.shown[1].parented).toBe(false)
  })
})

describe('quit-attempt state', () => {
  it('starts uncommitted and commits only when told', () => {
    expect(isQuitCommitted()).toBe(false)
    markQuitCommitted()
    expect(isQuitCommitted()).toBe(true)
  })

  // The never-reset-latch fix: a committed flag surviving an abandoned attempt
  // would make the NEXT quit skip both the confirmation and the session flush.
  it('resetQuitAttempt clears the commit so a later quit re-runs every gate', () => {
    markQuitCommitted()
    resetQuitAttempt()
    expect(isQuitCommitted()).toBe(false)

    // ...and the confirmation is armed again rather than sailing through.
    state.running = [{ processName: 'claude' }]
    expect(guardQuit({ preventDefault: vi.fn() }, fakeWin, vi.fn())).toBe('deferred')
  })

  it('Cancel resets the attempt, so a stale commit cannot leak into the next quit', async () => {
    // Contrived but load-bearing: whatever a previous attempt left behind, a
    // cancelled attempt must hand the next one a clean slate.
    markQuitCommitted()
    resetQuitAttempt()

    state.running = [{ processName: 'claude' }]
    state.responses = [1] // Cancel
    guardQuit({ preventDefault: vi.fn() }, fakeWin, vi.fn())
    await settle()

    expect(isQuitCommitted()).toBe(false)
  })
})
