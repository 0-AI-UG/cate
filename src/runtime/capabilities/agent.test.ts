// Real-subprocess coverage for the electron-free agent capability. It spawns a
// stand-in "pi" (a tiny node script) so we exercise the actual stdout line
// splitting, writeLine duplex, exit reporting, and stop() teardown without
// mocking child_process.

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createAgentCapability } from './agent'
import type { AgentDeps } from './agent'

let dir = ''
let echoCli = ''
let hangCli = ''

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cate-agent-test-'))
  // Echoes each stdin line back as `echo:<line>`; `quit` exits with code 7.
  echoCli = path.join(dir, 'echo-cli.js')
  await writeFile(
    echoCli,
    `let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line === 'quit') process.exit(7)
    process.stdout.write('echo:' + line + '\\n')
  }
})
process.stderr.write('agent-cli up\\n')
`,
  )
  // Stays alive until signalled, so stop() has something to tear down.
  hangCli = path.join(dir, 'hang-cli.js')
  await writeFile(hangCli, `setInterval(() => {}, 1000)\nprocess.stdout.write('ready\\n')\n`)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

function deps(cli: string): AgentDeps {
  return {
    ensurePi: async () => {},
    piCliPath: () => cli,
    nodeBin: () => process.execPath,
    baseEnv: () => ({ ...process.env } as Record<string, string>),
  }
}

describe('createAgentCapability', () => {
  test('splits stdout into lines, round-trips writeLine, and reports the exit code', async () => {
    const agent = createAgentCapability(deps(echoCli))
    const lines: string[] = []
    const exit = new Promise<{ code: number; stderr?: string }>((resolve) => {
      void agent.start(
        { id: 'a1', cwd: dir },
        (_id, line) => lines.push(line),
        (_id, code, stderr) => resolve({ code, stderr }),
      )
    })

    // Give the child a beat to come up, then drive it through stdin.
    await new Promise((r) => setTimeout(r, 150))
    agent.writeLine('a1', 'ping')
    agent.writeLine('a1', 'pong') // writeLine appends the newline itself
    await new Promise((r) => setTimeout(r, 100))
    agent.writeLine('a1', 'quit')

    const { code, stderr } = await exit
    expect(lines).toEqual(['echo:ping', 'echo:pong'])
    expect(code).toBe(7)
    expect(stderr).toContain('agent-cli up') // stderr tail surfaced on exit
  })

  test('stop() terminates a running agent and fires onExit', async () => {
    const agent = createAgentCapability(deps(hangCli))
    const exited = new Promise<void>((resolve) => {
      void agent.start({ id: 'a2', cwd: dir }, () => {}, () => resolve())
    })
    await new Promise((r) => setTimeout(r, 150))
    agent.stop('a2')
    // SIGTERM should bring it down well within the 1s SIGKILL fallback.
    await expect(Promise.race([exited, new Promise((_r, rej) => setTimeout(() => rej(new Error('onExit never fired')), 2000))])).resolves.toBeUndefined()
  })

  test('writeLine / stop on an unknown id are safe no-ops', () => {
    const agent = createAgentCapability(deps(echoCli))
    expect(() => agent.writeLine('nope', 'x')).not.toThrow()
    expect(() => agent.stop('nope')).not.toThrow()
  })
})
