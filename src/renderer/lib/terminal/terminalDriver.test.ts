// =============================================================================
// terminalDriver — renderer executor for the `cate.terminal.*` reverse API.
//
// Drives handleTerminalMethod against a mocked app store + terminal registry +
// cateAgent store + terminalWrite IPC, covering: target resolution (explicit
// panelId for everything, focused-terminal default for read ONLY), reading the
// alt vs normal xterm buffer, type writing verbatim text (no newline), press
// key sequences incl. computed ctrl-<letter> chords, the agent-owned-terminal
// input rejection, and the stable error vocabulary.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const WS = 'ws-1'

interface FakeEntry {
  terminal: { buffer: { active: { type: string; length: number; getLine: (i: number) => { translateToString: (trim: boolean) => string } | undefined } } }
  ptyId: string
  alive: boolean
}

function makeEntry(lines: string[], opts: { alt?: boolean; ptyId?: string; alive?: boolean } = {}): FakeEntry {
  return {
    terminal: {
      buffer: {
        active: {
          type: opts.alt ? 'alternate' : 'normal',
          length: lines.length,
          getLine: (i: number) => ({ translateToString: (_trim: boolean) => lines[i] }),
        },
      },
    },
    ptyId: opts.ptyId ?? 'pty-1',
    alive: opts.alive ?? true,
  }
}

const h = vi.hoisted(() => ({
  workspaces: [] as Array<{ id: string; panels: Record<string, { id: string; type: string; title: string }> }>,
  activePanelId: null as string | null,
  entries: new Map<string, unknown>(),
  controlledTerminals: {} as Record<string, string>,
  terminalWrite: vi.fn(async (_ptyId: string, _data: string) => {}),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: { getState: () => ({ workspaces: h.workspaces }) },
}))

vi.mock('../activePanel', () => ({
  getActivePanelId: () => h.activePanelId,
}))

vi.mock('./registryState', () => ({
  getEntry: (panelId: string) => h.entries.get(panelId),
}))

vi.mock('../../../cateAgent/renderer/cateAgentStore', () => ({
  useCateAgentStore: {
    getState: () => ({ byWs: { [WS]: { controlledTerminals: h.controlledTerminals } } }),
  },
}))

import { handleTerminalMethod, sequenceForKey } from './terminalDriver'

const M = (name: string) => `cate.terminal.${name}`

beforeEach(() => {
  vi.clearAllMocks()
  h.activePanelId = null
  h.entries = new Map()
  h.controlledTerminals = {}
  h.workspaces = [
    {
      id: WS,
      panels: {
        t1: { id: 't1', type: 'terminal', title: 'Term 1' },
        t2: { id: 't2', type: 'terminal', title: 'Term 2' },
        ed: { id: 'ed', type: 'editor', title: 'a.ts' },
      },
    },
  ]
  ;(globalThis as unknown as { window: { electronAPI: unknown } }).window = {
    electronAPI: { terminalWrite: h.terminalWrite },
  }
})

describe('target resolution', () => {
  it('read routes to an explicit args.panelId', async () => {
    h.entries.set('t2', makeEntry(['from t2']))
    const out = await handleTerminalMethod(WS, M('read'), { panelId: 't2' })
    expect(out).toEqual({ ok: true, result: { panelId: 't2', alt: false, text: 'from t2' } })
  })

  it('read defaults to the focused panel when it is a terminal', async () => {
    h.activePanelId = 't1'
    h.entries.set('t1', makeEntry(['hello']))
    const out = await handleTerminalMethod(WS, M('read'), {})
    expect(out).toEqual({ ok: true, result: { panelId: 't1', alt: false, text: 'hello' } })
  })

  it('read with a focused NON-terminal errors no-terminal-focused (no first-terminal fallback)', async () => {
    h.activePanelId = 'ed'
    h.entries.set('t1', makeEntry(['hello']))
    expect(await handleTerminalMethod(WS, M('read'), {})).toEqual({ ok: false, error: 'no-terminal-focused' })
  })

  it('read with nothing focused errors no-terminal-focused', async () => {
    expect(await handleTerminalMethod(WS, M('read'), {})).toEqual({ ok: false, error: 'no-terminal-focused' })
  })

  it('rejects an explicit panelId that is not a terminal in this window', async () => {
    expect(await handleTerminalMethod(WS, M('read'), { panelId: 'ed' })).toEqual({ ok: false, error: 'terminal-not-found' })
    expect(await handleTerminalMethod(WS, M('read'), { panelId: 'ghost' })).toEqual({ ok: false, error: 'terminal-not-found' })
  })

  it('type/press never resolve implicitly, even with a focused terminal', async () => {
    h.activePanelId = 't1'
    h.entries.set('t1', makeEntry(['hello']))
    expect(await handleTerminalMethod(WS, M('type'), { text: 'ls' })).toEqual({ ok: false, error: 'panel-required' })
    expect(await handleTerminalMethod(WS, M('press'), { key: 'enter' })).toEqual({ ok: false, error: 'panel-required' })
    expect(h.terminalWrite).not.toHaveBeenCalled()
  })

  it('reports terminal-not-ready when the panel exists but has no registry entry', async () => {
    expect(await handleTerminalMethod(WS, M('read'), { panelId: 't1' })).toEqual({ ok: false, error: 'terminal-not-ready' })
  })

  it('reports unsupported for an unknown method', async () => {
    expect(await handleTerminalMethod(WS, M('frobnicate'), {})).toEqual({ ok: false, error: 'unsupported' })
  })
})

describe('read', () => {
  it('reads the normal buffer including scrollback and trims trailing blank lines', async () => {
    h.entries.set('t1', makeEntry(['old scrollback', '$ ls', 'a.ts', '', '']))
    const out = await handleTerminalMethod(WS, M('read'), { panelId: 't1' })
    expect(out).toEqual({ ok: true, result: { panelId: 't1', alt: false, text: 'old scrollback\n$ ls\na.ts' } })
  })

  it('reports the alternate buffer (TUI screen) with alt: true', async () => {
    h.entries.set('t1', makeEntry(['┌ TUI ┐', '└─────┘'], { alt: true }))
    const out = await handleTerminalMethod(WS, M('read'), { panelId: 't1' })
    expect(out).toEqual({ ok: true, result: { panelId: 't1', alt: true, text: '┌ TUI ┐\n└─────┘' } })
  })

  it('still reads a dead (exited) terminal buffer', async () => {
    // Registry membership != liveness: the buffer of an exited terminal is
    // exactly what a caller wants to read post-mortem.
    h.entries.set('t1', makeEntry(['[Process exited]'], { alive: false }))
    const out = await handleTerminalMethod(WS, M('read'), { panelId: 't1' })
    expect(out).toEqual({ ok: true, result: { panelId: 't1', alt: false, text: '[Process exited]' } })
  })
})

describe('type', () => {
  it('writes the text verbatim to the PTY with NO trailing newline', async () => {
    h.entries.set('t1', makeEntry([]))
    const out = await handleTerminalMethod(WS, M('type'), { panelId: 't1', text: 'ls -la' })
    expect(out).toEqual({ ok: true })
    expect(h.terminalWrite).toHaveBeenCalledWith('pty-1', 'ls -la')
  })

  it('requires text', async () => {
    h.entries.set('t1', makeEntry([]))
    expect(await handleTerminalMethod(WS, M('type'), { panelId: 't1' })).toEqual({ ok: false, error: 'text-required' })
    expect(await handleTerminalMethod(WS, M('type'), { panelId: 't1', text: '' })).toEqual({ ok: false, error: 'text-required' })
  })

  it('rejects input into a dead terminal as terminal-not-ready', async () => {
    h.entries.set('t1', makeEntry([], { alive: false }))
    expect(await handleTerminalMethod(WS, M('type'), { panelId: 't1', text: 'ls' })).toEqual({ ok: false, error: 'terminal-not-ready' })
    expect(h.terminalWrite).not.toHaveBeenCalled()
  })

  it('maps a throwing terminalWrite to terminal-not-ready', async () => {
    h.entries.set('t1', makeEntry([]))
    h.terminalWrite.mockRejectedValueOnce(new Error('pty gone'))
    expect(await handleTerminalMethod(WS, M('type'), { panelId: 't1', text: 'ls' })).toEqual({ ok: false, error: 'terminal-not-ready' })
  })
})

describe('press', () => {
  it.each([
    ['enter', '\r'],
    ['Return', '\r'],
    ['tab', '\t'],
    ['ESC', '\x1b'],
    ['escape', '\x1b'],
    ['backspace', '\x7f'],
    ['space', ' '],
    ['up', '\x1b[A'],
    ['down', '\x1b[B'],
    ['right', '\x1b[C'],
    ['left', '\x1b[D'],
    ['pageup', '\x1b[5~'],
    ['pagedown', '\x1b[6~'],
    ['home', '\x1b[H'],
    ['end', '\x1b[F'],
  ])('sends the sequence for %s', async (key, seq) => {
    h.entries.set('t1', makeEntry([]))
    const out = await handleTerminalMethod(WS, M('press'), { panelId: 't1', key })
    expect(out).toEqual({ ok: true })
    expect(h.terminalWrite).toHaveBeenCalledWith('pty-1', seq)
  })

  it('computes ctrl-<letter> chords instead of enumerating them', async () => {
    h.entries.set('t1', makeEntry([]))
    await handleTerminalMethod(WS, M('press'), { panelId: 't1', key: 'ctrl-c' })
    expect(h.terminalWrite).toHaveBeenCalledWith('pty-1', '\x03')
    await handleTerminalMethod(WS, M('press'), { panelId: 't1', key: 'Ctrl+D' })
    expect(h.terminalWrite).toHaveBeenCalledWith('pty-1', '\x04')
    expect(sequenceForKey('ctrl-a')).toBe('\x01')
    expect(sequenceForKey('ctrl-z')).toBe('\x1a')
  })

  it('rejects an unknown key without touching the PTY', async () => {
    h.entries.set('t1', makeEntry([]))
    expect(await handleTerminalMethod(WS, M('press'), { panelId: 't1', key: 'F13' })).toEqual({ ok: false, error: 'unsupported-key' })
    expect(await handleTerminalMethod(WS, M('press'), { panelId: 't1', key: 'ctrl-1' })).toEqual({ ok: false, error: 'unsupported-key' })
    expect(await handleTerminalMethod(WS, M('press'), { panelId: 't1' })).toEqual({ ok: false, error: 'unsupported-key' })
    expect(h.terminalWrite).not.toHaveBeenCalled()
  })
})

describe('agent-owned terminals', () => {
  it('rejects type/press into a terminal the Cate Agent is driving', async () => {
    h.entries.set('t1', makeEntry(['agent output']))
    h.controlledTerminals = { t1: 'rgb(1,2,3)' }
    expect(await handleTerminalMethod(WS, M('type'), { panelId: 't1', text: 'ls' })).toEqual({ ok: false, error: 'agent-owned-terminal' })
    expect(await handleTerminalMethod(WS, M('press'), { panelId: 't1', key: 'enter' })).toEqual({ ok: false, error: 'agent-owned-terminal' })
    expect(h.terminalWrite).not.toHaveBeenCalled()
  })

  it('still allows read on an agent-driven terminal', async () => {
    h.entries.set('t1', makeEntry(['agent output']))
    h.controlledTerminals = { t1: 'rgb(1,2,3)' }
    expect(await handleTerminalMethod(WS, M('read'), { panelId: 't1' })).toEqual({
      ok: true,
      result: { panelId: 't1', alt: false, text: 'agent output' },
    })
  })

  it('another terminal in the same workspace stays writable', async () => {
    h.entries.set('t2', makeEntry([], { ptyId: 'pty-2' }))
    h.controlledTerminals = { t1: 'rgb(1,2,3)' }
    expect(await handleTerminalMethod(WS, M('type'), { panelId: 't2', text: 'ls' })).toEqual({ ok: true })
    expect(h.terminalWrite).toHaveBeenCalledWith('pty-2', 'ls')
  })
})
