import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { findTextLinks, logicalLineAt, rowLinks, type LogicalLine } from './links'

/** A headless xterm `cols` wide holding `data`. */
async function terminalWith(cols: number, data: string): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows: 10, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(data, resolve))
  return terminal
}

/** Text offsets `start`..`end` of a line as an xterm range (1-based, end
 *  inclusive), as a view draws it. */
function rangeOf(line: LogicalLine, start: number, end: number) {
  const from = line.cells[start]
  const to = line.cells[end - 1]
  return { start: { x: from.x + 1, y: from.y + 1 }, end: { x: to.x + to.width, y: to.y + 1 } }
}

const files = (text: string) => findTextLinks(text).filter((link) => link.kind === 'file')

describe('findTextLinks', () => {
  it('finds URLs and paths with their line and column', () => {
    const text = 'see https://example.com/a/b.ts?x=1. and src/foo.ts:12:5, then ./lib/b.js'
    const links = findTextLinks(text)
    expect(links.map((link) => text.slice(link.start, link.end))).toEqual(['https://example.com/a/b.ts?x=1', 'src/foo.ts:12:5', './lib/b.js'])
    expect(links[0]).toMatchObject({ kind: 'url', url: 'https://example.com/a/b.ts?x=1' })
    expect(links[1]).toMatchObject({ kind: 'file', path: 'src/foo.ts', line: 12, column: 5 })
    expect(links[2]).toMatchObject({ kind: 'file', path: './lib/b.js' })
    expect(links[2]).not.toHaveProperty('line')
  })

  it('parses absolute, parent and Windows paths', () => {
    expect(files('/Users/x/proj/file.tsx:10:2')[0]).toMatchObject({ path: '/Users/x/proj/file.tsx', line: 10, column: 2 })
    expect(files('../shared/types.ts:7')[0]).toMatchObject({ path: '../shared/types.ts', line: 7 })
    expect(files('error src\\foo.ts:12:5')[0]).toMatchObject({ path: 'src\\foo.ts', line: 12, column: 5 })
    expect(files('at C:\\Users\\x\\foo.tsx:10:2')[0]).toMatchObject({ path: 'C:\\Users\\x\\foo.tsx', line: 10 })
    expect(files('C:/Users/x/file.ts:3')[0]).toMatchObject({ path: 'C:/Users/x/file.ts', line: 3 })
  })

  it('leaves out trailing punctuation, bare file names and prose', () => {
    const text = 'check src/foo.ts.'
    const [link] = files(text)
    expect(text.slice(link.start, link.end)).toBe('src/foo.ts')
    expect(findTextLinks('see README.md for info')).toEqual([])
    expect(findTextLinks('hello world, nothing here')).toEqual([])
  })

  it('does not link a URL a program cut short with an ellipsis', () => {
    expect(findTextLinks('❯ Docs at https://example.com/aaaa/bb… │')).toEqual([])
  })

  it('does not find a path inside a URL', () => {
    expect(findTextLinks('https://github.com/o/r/blob/main/src/a.ts').map((link) => link.kind)).toEqual(['url'])
  })
})

describe('logicalLineAt', () => {
  it('joins rows the terminal soft-wrapped, from any of them', async () => {
    const url = 'https://example.com/aaaa/bbbb/cccc/dddd/eeee'
    const terminal = await terminalWith(20, `go ${url} now\r\nnext`)
    const buffer = terminal.buffer.active
    for (const y of [0, 1, 2]) {
      const line = logicalLineAt(buffer, y, terminal.cols)!
      expect(line.text.trimEnd()).toBe(`go ${url} now`)
      const [link] = findTextLinks(line.text)
      expect(rangeOf(line, link.start, link.end)).toEqual({ start: { x: 4, y: 1 }, end: { x: 7, y: 3 } })
    }
    expect(logicalLineAt(buffer, 3, terminal.cols)!.text.trimEnd()).toBe('next')
  })

  it('ends a link at a newline the program wrote, even where it broke the link', async () => {
    const terminal = await terminalWith(30, '• https://example.com/aaaa/bbb\r\n  b/cccc?q=1 done')
    expect(findTextLinks(logicalLineAt(terminal.buffer.active, 0, terminal.cols)!.text)).toMatchObject([{ url: 'https://example.com/aaaa/bbb' }])
    expect(logicalLineAt(terminal.buffer.active, 1, terminal.cols)!.text.trimEnd()).toBe('  b/cccc?q=1 done')
  })

  it('maps text past wide characters to their cells', async () => {
    const terminal = await terminalWith(40, '日本 src/a.ts')
    const line = logicalLineAt(terminal.buffer.active, 0, terminal.cols)!
    const [link] = findTextLinks(line.text)
    expect(rangeOf(line, link.start, link.end)).toEqual({ start: { x: 6, y: 1 }, end: { x: 13, y: 1 } })
  })

  it('reads a wide character the row could not fit as continuing on the next row', async () => {
    // 9 columns: `src/a.ts` fills 8, `日` does not fit the 9th and wraps.
    const terminal = await terminalWith(9, 'src/a.ts日/b.ts')
    const line = logicalLineAt(terminal.buffer.active, 0, terminal.cols)!
    expect(line.text.trimEnd()).toBe('src/a.ts日/b.ts')
  })
})

describe('rowLinks', () => {
  it('gives the links on a row, files only when they exist, resolved against the cwd', async () => {
    const terminal = await terminalWith(30, 'src/a.ts:3, src/gone.ts, ok\r\nhttps://example.com/aaaa/bbbb/cccc/dddd')
    const isFile = async (file: string) => file === '/repo/src/a.ts'
    expect(await rowLinks(terminal.buffer.active, terminal.cols, 0, '/repo', isFile)).toEqual([
      { target: { kind: 'file', path: '/repo/src/a.ts', line: 3 }, text: 'src/a.ts:3', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    ])
    // The URL soft-wraps onto row 2: both rows answer with it.
    const url = { target: { kind: 'url', url: 'https://example.com/aaaa/bbbb/cccc/dddd' }, text: 'https://example.com/aaaa/bbbb/cccc/dddd', start: { x: 0, y: 1 }, end: { x: 9, y: 2 } }
    expect(await rowLinks(terminal.buffer.active, terminal.cols, 1, '/repo', isFile)).toEqual([url])
    expect(await rowLinks(terminal.buffer.active, terminal.cols, 2, '/repo', isFile)).toEqual([url])
  })

  it('resolves parent paths and keeps absolute ones', async () => {
    const terminal = await terminalWith(40, '../x/b.ts /abs/c.ts')
    const links = await rowLinks(terminal.buffer.active, terminal.cols, 0, '/repo/sub', async () => true)
    expect(links.map((link) => link.target)).toEqual([{ kind: 'file', path: '/repo/x/b.ts' }, { kind: 'file', path: '/abs/c.ts' }])
  })
})

/** Every link `rowLinks` finds on any row of `lines` printed one per line
 *  (each a newline apart, as shells and most programs print), in a terminal
 *  `cols` wide; every path names a file. */
async function screenLinks(cols: number, lines: string[]): Promise<string[]> {
  const terminal = new Terminal({ cols, rows: lines.length * 4, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(lines.join('\r\n'), resolve))
  const found = new Set<string>()
  for (let y = 0; y < terminal.buffer.active.length; y++) {
    for (const link of await rowLinks(terminal.buffer.active, cols, y, '/', async () => true)) found.add(link.text)
  }
  terminal.dispose()
  return [...found].sort()
}

/** The links of each line on its own. */
const linesLinks = (lines: string[]) => [...new Set(lines.flatMap((line) => findTextLinks(line).map((link) => line.slice(link.start, link.end))))].sort()

describe('output that only ends in a link is not joined to the next line', () => {
  it('a shell error ending in a URL, then the prompt, at every width', async () => {
    // Seen in a zsh terminal 89 columns wide.
    const lines = ['anton@Mac zero-agent % https://claude.ai/artifact/BH3uwBtUUsJ3U4uPV2reUX', 'zsh: no such file or directory: https://claude.ai/artifact/BH3uwBtUUsJ3U4uPV2reUX', 'anton@Mac zero-agent % ', 'anton@Mac zero-agent % ']
    for (let cols = 30; cols <= 120; cols++) {
      expect(await screenLinks(cols, lines), `${cols} columns`).toEqual(['https://claude.ai/artifact/BH3uwBtUUsJ3U4uPV2reUX'])
    }
  })

  it('shell, git, npm and compiler output, at every width', async () => {
    const lines = [
      'anton@Mac cate % git push',
      'remote: Create a pull request for \'feature/links\' on GitHub by visiting:',
      'remote:      https://github.com/0-AI-UG/cate/pull/new/feature/links',
      'remote:',
      'To github.com:0-AI-UG/cate.git',
      'anton@Mac cate % open https://example.com/docs/',
      'anton@Mac cate % ls src/services/terminal/runtime/',
      'src/services/terminal/runtime/links.ts',
      'src/services/terminal/runtime/loginEnv.ts',
      'src/services/terminal/runtime/procfs.ts',
      'src/services/terminal/runtime/README.md',
      '  modified:   src/services/terminal/runtime/links.ts',
      'src/app.ts:12:5 - error TS2322: Type \'string\' is not assignable to type \'number\'.',
      'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported, see https://github.com/isaacs/node-glob/issues/',
      'https://registry.npmjs.org/@xterm/headless/-/headless-5.5.0.tgz',
      'https://registry.npmjs.org/@xterm/xterm/-/xterm-5.5.0.tgz',
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: use --host to expose',
      'npm error A complete log of this run can be found in: /Users/anton/.npm/_logs/2026-10-14T08_52_02_000Z-debug-0.log',
      'anton@Mac cate % ',
    ]
    const expected = linesLinks(lines)
    for (let cols = 30; cols <= 140; cols++) {
      expect(await screenLinks(cols, lines), `${cols} columns`).toEqual(expected)
    }
  })
})
