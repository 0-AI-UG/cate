// Real TUI -> Cate's terminal links. Each installed agent CLI prints a reply
// with a URL and a `path:line:col` from the local model fixture, in a PTY with
// the env Cate gives its terminals, at two widths. A link the CLI names
// itself (OSC 8) or keeps on one row must open whole from every cell of it,
// through the OSC 8 hyperlink, else through the links the runtime finds on
// its screen. A link the CLI broke over rows with its own newlines is not
// one link on the screen, and is not checked. See docs/agent-hook-ci.md.
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, test } from 'vitest'
import { osc8Target, type TerminalLinkTarget } from '@services/terminal/contract'
import { TERMINAL_LINK_ENV } from '@services/terminal/runtime'
import { logicalLineAt, rowLinks } from '@services/terminal/runtime/links'
import { AGENT_DEFS } from '../../contract'
import { createAgentHooks } from '../hooks/agentHooks'
import { runLiveCli, runLiveTui } from '../changes/liveHarness'
import { cleanHookEnv, configureHookCli } from './hookCliFixture'
import { redactHookSmokeOutput, selectHookSmokeAgents } from './hookSmoke.config'
import { createHookMockProvider } from './hookMockProvider'

const live = process.env.CATE_LIVE_AGENT_CLIS === '1'
const selected = selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS)

// grok's text column is about 36 cells wide in a 50-column terminal.
const URL = 'https://example.com/docs?q=42'
const FILE = 'src/parts/linkTarget.ts'
const FILE_TEXT = `${FILE}:42:7`
const PROMPT = 'Reply with the two links.'
/** Output quiet for this long after the reply means the TUI drew its last frame. */
const SETTLED_MS = 1_500

/** The OSC 8 target xterm keeps on a cell; no public API reads it. */
function oscUriAt(terminal: Terminal, x: number, y: number): string | undefined {
  type Line = { _data: Uint32Array; _extendedAttrs: Record<number, { urlId?: number } | undefined> }
  const core = (terminal as unknown as { _core: { buffer: { lines: { get(y: number): Line | undefined } }; _oscLinkService: { getLinkData(id: number): { uri: string } | undefined } } })._core
  const line = core.buffer.lines.get(y)
  // BgFlags.HAS_EXTENDED on the cell's background word.
  const id = line && (line._data[x * 3 + 2] & 0x10000000) ? line._extendedAttrs[x]?.urlId : undefined
  return id ? core._oscLinkService.getLinkData(id)?.uri : undefined
}

/** What a Cmd+click opens, as a view resolves it, from every cell of each
 *  occurrence of `text` the CLI kept on one row and from every cell it linked
 *  to a URI with `part` by OSC 8: the cell's OSC 8 hyperlink first (xterm asks
 *  its own provider before Cate's), else the link the runtime finds on the
 *  cell's row (null: nothing). Empty when the CLI showed it neither way. */
async function openedFrom(terminal: Terminal, cwd: string, text: string, part: string): Promise<(TerminalLinkTarget | null)[]> {
  const isFile = async (file: string) => (await stat(file).catch(() => null))?.isFile() ?? false
  const opened = new Map<string, TerminalLinkTarget | null>()
  const buffer = terminal.buffer.active
  for (let y = 0; y < buffer.length; y++) {
    const cells = new Set<number>()
    const line = logicalLineAt(buffer, y, terminal.cols)!
    for (let i = line.text.indexOf(text); i >= 0; i = line.text.indexOf(text, i + 1)) {
      const occurrence = line.cells.slice(i, i + text.length)
      if (occurrence.every((cell) => cell.y === y)) for (const cell of occurrence) cells.add(cell.x)
    }
    for (let x = 0; x < terminal.cols; x++) if (oscUriAt(terminal, x, y)?.includes(part)) cells.add(x)
    if (cells.size === 0) continue
    const links = await rowLinks(buffer, terminal.cols, y, cwd, isFile)
    for (const x of cells) {
      const uri = oscUriAt(terminal, x, y)
      const target = uri ? osc8Target(uri) : links.find(({ start, end }) => (y > start.y || (y === start.y && x >= start.x))
        && (y < end.y || (y === end.y && x < end.x)))?.target ?? null
      opened.set(JSON.stringify(target), target)
    }
  }
  return [...opened.values()]
}

/** The frame the links were read from: each row with its soft-wrap flag and
 *  the OSC 8 targets on it, for a failure to show what the CLI drew. */
function screenDump(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  const rows: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)!
    const text = line.translateToString(true)
    if (!text.trim()) continue
    const osc = [...new Set(Array.from({ length: terminal.cols }, (_, x) => oscUriAt(terminal, x, y)).filter(Boolean))]
    rows.push(`${y} ${line.isWrapped ? 'W' : '-'} ${JSON.stringify(text)}${osc.length ? ` osc8=${JSON.stringify(osc)}` : ''}`)
  }
  return rows.join('\n')
}

describe.skipIf(!live)('agent CLI terminal links', () => {
  for (const agentId of selected) {
    for (const cols of [50, 80]) {
      test(`${agentId} at ${cols} columns: a URL and a file link open whole`, { timeout: 240_000 }, async () => {
        const command = AGENT_DEFS[agentId].command
        // macOS's default TMPDIR alone can exhaust a daemon's Unix socket path limit.
        const directory = await realpath(await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `cate-links-${agentId}-`)))
        const cwd = path.join(directory, 'repo')
        const hooks = createAgentHooks({ hooksDir: path.join(directory, 'hooks'), changesDir: path.join(directory, 'changes') })
        const env = { ...cleanHookEnv(), ...TERMINAL_LINK_ENV }
        let reply = ''
        const provider = await createHookMockProvider({ reply: () => ({ type: 'text', text: reply }) })
        reply = `Docs at ${URL} and code at ${FILE_TEXT} thanks. ${provider.answer}`
        const terminal = new Terminal({ cols, rows: 30, scrollback: 5000, allowProposedApi: true })
        let launch: Awaited<ReturnType<typeof configureHookCli>> | undefined
        let urls: (TerminalLinkTarget | null)[] = []
        let files: (TerminalLinkTarget | null)[] = []
        let frame = ''
        try {
          await mkdir(path.join(cwd, path.dirname(FILE)), { recursive: true })
          await writeFile(path.join(cwd, FILE), 'export {}\n')
          await runLiveCli('git', ['init', '-q'], { cwd, env })
          await hooks.prepareWorkspace(cwd, { [agentId]: 'on' })
          launch = await configureHookCli(agentId, directory, cwd, env, provider, PROMPT)
          let lastOutput = Date.now()
          await runLiveTui(command, launch.args, {
            cwd, env, cols, rows: 30, timeout: 120_000, renderScreen: true,
            onData: (chunk) => { lastOutput = Date.now(); terminal.write(chunk) },
            complete: async (screen) => {
              if (!screen.replace(/\s/g, '').includes(provider.answer) || Date.now() - lastOutput < SETTLED_MS) return false
              // Read the last frame before the CLI is stopped and redraws.
              await new Promise<void>((resolve) => terminal.write('', resolve))
              urls = await openedFrom(terminal, cwd, URL, URL)
              files = await openedFrom(terminal, cwd, FILE_TEXT, FILE)
              frame = screenDump(terminal)
              return true
            },
          }).catch((error) => { throw new Error(redactHookSmokeOutput(String(error), env)) })
          if (urls.length > 0) expect(urls, `every cell of the URL opens all of it\n${frame}`).toEqual([{ kind: 'url', url: URL }])
          if (files.length > 0) expect(files, `every cell of the path opens it at its line\n${frame}`).toEqual([{ kind: 'file', path: path.join(cwd, FILE), line: 42, column: 7 }])
        } finally {
          terminal.dispose()
          hooks.dispose()
          await provider.close()
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        }
      })
    }
  }
})
