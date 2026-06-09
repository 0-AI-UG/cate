// =============================================================================
// scrollbackSerialize — round-trip fidelity for serializeTerminalState().
//
// The cross-window transfer path serializes a terminal's buffer and writes it
// into a fresh xterm in the receiving window. These tests use a REAL xterm
// Terminal + SerializeAddon to prove the serialized string restores not just
// text but ANSI styling (color + bold) verbatim — the thing the old plain-text
// translateToString() capture silently dropped.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { serializeTerminalState } from './scrollbackCapture'

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()))
}

function withSerialize(cols: number, rows: number): { term: Terminal; addon: SerializeAddon } {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  const addon = new SerializeAddon()
  term.loadAddon(addon)
  return { term, addon }
}

describe('serializeTerminalState', () => {
  it('returns undefined when no serialize addon is present', () => {
    expect(serializeTerminalState({})).toBeUndefined()
    expect(serializeTerminalState({ serializeAddon: null })).toBeUndefined()
  })

  it('returns undefined for an empty buffer', () => {
    const { term, addon } = withSerialize(80, 24)
    expect(serializeTerminalState({ serializeAddon: addon })).toBeUndefined()
    term.dispose()
  })

  it('round-trips text + color + bold into a fresh terminal', async () => {
    const { term: src, addon } = withSerialize(80, 24)
    // red "ERROR", default "ok", bold-green "DONE"
    await write(src, '\x1b[31mERROR\x1b[0m ok \x1b[1;32mDONE\x1b[0m\r\n')

    const serialized = serializeTerminalState({ serializeAddon: addon })
    expect(serialized).toBeTruthy()
    expect(serialized).toContain('\x1b[') // carries SGR sequences, not plain text

    // Replay into a fresh same-size terminal, exactly like the receiving window.
    const dst = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    await write(dst, serialized!)

    const srcLine = src.buffer.active.getLine(0)!
    const dstLine = dst.buffer.active.getLine(0)!
    expect(dstLine.translateToString(true)).toBe('ERROR ok DONE')

    // The 'E' of ERROR keeps its red foreground.
    const srcE = srcLine.getCell(0)!
    const dstE = dstLine.getCell(0)!
    expect(dstE.getChars()).toBe('E')
    expect(dstE.getFgColor()).toBe(srcE.getFgColor())
    expect(dstE.isFgPalette()).toBe(srcE.isFgPalette())

    // The 'D' of DONE keeps bold + green.
    const dstD = dstLine.getCell(9)!
    expect(dstD.getChars()).toBe('D')
    expect(dstD.isBold()).toBeTruthy()
    expect(dstD.getFgColor()).toBe(srcLine.getCell(9)!.getFgColor())

    src.dispose()
    dst.dispose()
  })
})
