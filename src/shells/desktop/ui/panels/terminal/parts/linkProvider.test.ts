import { describe, expect, it, vi } from 'vitest'
import type { ILink } from '@xterm/xterm'
import { Terminal } from '@xterm/headless'
import type { TerminalLink } from '@services/terminal/contract'
import { createLinkProvider, createOsc8Handler, linkClick, type LinkPorts } from './linkProvider'

async function terminalWith(cols: number, data: string): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows: 4, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(data, resolve))
  return terminal
}

function ports(links: TerminalLink[] = []) {
  return {
    links: vi.fn(async () => links),
    open: vi.fn(),
  } satisfies LinkPorts
}

const linksAt = (provider: ReturnType<typeof createLinkProvider>, y: number) =>
  new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(y, resolve))

const cmd = (shiftKey = false) => ({ metaKey: true, ctrlKey: false, shiftKey }) as MouseEvent

describe('createLinkProvider', () => {
  it('asks the runtime for the row counted from the end and draws its links on the rows they cover', async () => {
    // Rows 1..4 of 4: the URL runs from row 2 (row 2 from the end) to row 3.
    const terminal = await terminalWith(16, 'one\r\nsee https://example.com/aa\r\nlast')
    const url = 'https://example.com/aa'
    const p = ports([{ target: { kind: 'url', url }, text: url, start: { x: 4, row: 2 }, end: { x: 10, row: 1 } }])
    const [link] = (await linksAt(createLinkProvider(terminal, p, true), 3))!
    expect(p.links).toHaveBeenCalledWith(1, 'ple.com/aa')
    expect(link.range).toEqual({ start: { x: 5, y: 2 }, end: { x: 10, y: 3 } })
    link.activate({ metaKey: false, ctrlKey: true, shiftKey: false } as MouseEvent, link.text)
    expect(p.open).not.toHaveBeenCalled()
    link.activate(cmd(), link.text)
    link.activate(cmd(true), link.text)
    expect(p.open.mock.calls).toEqual([[{ kind: 'url', url }, false], [{ kind: 'url', url }, true]])
  })

  it('does not ask for a blank row, and answers undefined without links', async () => {
    const terminal = await terminalWith(20, 'nothing here')
    const p = ports()
    const provider = createLinkProvider(terminal, p, true)
    expect(await linksAt(provider, 1)).toBeUndefined()
    expect(await linksAt(provider, 3)).toBeUndefined()
    expect(p.links.mock.calls).toEqual([[3, 'nothing here']])
  })
})

describe('linkClick', () => {
  const click = (m: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>>) => ({ metaKey: false, ctrlKey: false, shiftKey: false, ...m })

  it('opens with the platform modifier, outside with Shift, never on a plain click', () => {
    expect(linkClick(click({ metaKey: true }), true)).toBe('open')
    expect(linkClick(click({ metaKey: true, shiftKey: true }), true)).toBe('external')
    expect(linkClick(click({ ctrlKey: true }), true)).toBeNull()
    expect(linkClick(click({ ctrlKey: true }), false)).toBe('open')
    expect(linkClick(click({ ctrlKey: true, shiftKey: true }), false)).toBe('external')
    expect(linkClick(click({ metaKey: true }), false)).toBeNull()
    expect(linkClick(click({}), true)).toBeNull()
  })
})

describe('createOsc8Handler', () => {
  it('opens OSC 8 hyperlinks the program named, however they wrap', () => {
    const p = ports()
    const handler = createOsc8Handler(p, false)
    const range = { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } }
    handler.activate({ metaKey: false, ctrlKey: true, shiftKey: false } as MouseEvent, 'file:///repo/a.ts:3', range)
    handler.activate({ metaKey: false, ctrlKey: true, shiftKey: true } as MouseEvent, 'https://example.com', range)
    handler.activate({ metaKey: false, ctrlKey: false, shiftKey: false } as MouseEvent, 'https://plain.click', range)
    handler.activate({ metaKey: false, ctrlKey: true, shiftKey: false } as MouseEvent, 'vscode://x', range)
    expect(p.open.mock.calls).toEqual([
      [{ kind: 'file', path: '/repo/a.ts', line: 3 }, false],
      [{ kind: 'url', url: 'https://example.com' }, true],
    ])
  })
})
