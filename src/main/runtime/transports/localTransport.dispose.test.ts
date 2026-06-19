import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { LocalSubprocessTransport } from './localTransport'

// FIX [16]: graceful daemon shutdown. dispose()/kill() must first CLOSE the
// child's stdin (the daemon's `process.stdin.on('close')` handler reaps its pty
// groups + exits), and only hard-kill if the child lingers past the grace
// window. This matters most on Windows, where a bare child.kill() terminates the
// process hard and orphans pty grandchildren. These tests drive a real Node
// subprocess so the behavior is verified end-to-end, deterministically.

let dir: string

// A tiny daemon stand-in: exits cleanly when its stdin closes (mirrors the real
// daemon's stdin-close → killAllGroups → exit handler). Ignores SIGTERM so the
// test proves the EXIT came from the stdin-close path, not from a kill.
const STDIN_CLOSE_EXITS = `
  process.on('SIGTERM', () => {});
  process.stdin.resume();
  process.stdin.on('close', () => process.exit(0));
  process.stdout.write('ready\\n');
  setInterval(() => {}, 1000);
`

// Ignores BOTH stdin-close and SIGTERM, so only a hard kill (SIGKILL) can stop
// it — proves dispose() force-kills after the grace window.
const UNKILLABLE_EXCEPT_HARD = `
  process.on('SIGTERM', () => {});
  process.stdin.resume();
  process.stdin.on('close', () => {});
  process.stdout.write('ready\\n');
  setInterval(() => {}, 1000);
`

const EXITS_IMMEDIATELY = `
  process.stdout.write('ready\\n');
  process.exit(0);
`

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cate-dispose-test-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function launchWith(script: string, name: string): Promise<{
  transport: LocalSubprocessTransport
  channel: Awaited<ReturnType<LocalSubprocessTransport['launch']>>
  exit: Promise<{ code: number | null }>
}> {
  const bundlePath = path.join(dir, `${name}.cjs`)
  await writeFile(bundlePath, script)
  const transport = new LocalSubprocessTransport({
    nodePath: process.execPath,
    bundlePath,
    root: process.cwd(),
    id: 'dispose_test',
  })
  const channel = await transport.launch()
  await new Promise<void>((resolve) => {
    channel.onData((chunk) => { if (chunk.toString().includes('ready')) resolve() })
  })
  const exit = new Promise<{ code: number | null }>((resolve) => channel.onClose(resolve))
  return { transport, channel, exit }
}

describe('LocalSubprocessTransport graceful shutdown (FIX 16)', () => {
  test('dispose() closes stdin so the daemon exits gracefully (no hard kill)', async () => {
    const { transport, exit } = await launchWith(STDIN_CLOSE_EXITS, 'graceful')
    const start = Date.now()
    await transport.dispose()
    const { code } = await exit
    // The child ignores SIGTERM, so a clean exit (code 0) proves it came from the
    // stdin-close path — and well within the 1500ms grace window.
    expect(code).toBe(0)
    expect(Date.now() - start).toBeLessThan(1500)
  }, 15_000)

  test('dispose() force-kills after the grace window if the daemon lingers', async () => {
    const { transport, exit } = await launchWith(UNKILLABLE_EXCEPT_HARD, 'lingerer')
    const start = Date.now()
    await transport.dispose()
    const { code } = await exit
    // It ignored stdin-close and SIGTERM, so it only died from the SIGKILL sent
    // after the grace window — exit code is null (killed by signal).
    expect(code).toBe(null)
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000)
  }, 15_000)

  test('write after daemon exit fails synchronously instead of surfacing EPIPE as uncaught', async () => {
    const { channel, exit } = await launchWith(EXITS_IMMEDIATELY, 'exits-immediately')
    await exit

    expect(() => channel.write('{"t":"req","id":1,"method":"ping","params":[]}\n')).toThrow('Runtime stdin is closed')
  }, 15_000)
})
