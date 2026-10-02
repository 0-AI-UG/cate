import { describe, expect, it, vi } from 'vitest'
import { parseServeArgs, serveCommand, SERVE_USAGE } from './serve'

describe('parseServeArgs', () => {
  it('serves the current directory on the same network by default', () => {
    expect(parseServeArgs([], '/work/app')).toEqual({ kind: 'serve', root: '/work/app', network: 'sameNetwork', json: false })
  })

  it('resolves a relative path and takes --connect in any position', () => {
    expect(parseServeArgs(['--connect', '../other'], '/work/app')).toEqual({ kind: 'serve', root: '/work/other', network: 'cateConnect', json: false })
    expect(parseServeArgs(['/abs', '--connect', '--json'], '/work/app')).toEqual({ kind: 'serve', root: '/abs', network: 'cateConnect', json: true })
  })

  it('refuses unknown options and a second path; -h asks for help', () => {
    expect(parseServeArgs(['--network', 'x'], '/w')).toEqual({ kind: 'error', message: 'unknown option --network' })
    expect(parseServeArgs(['a', 'b'], '/w')).toEqual({ kind: 'error', message: 'unexpected argument b' })
    expect(parseServeArgs(['a', '-h'], '/w')).toEqual({ kind: 'help' })
  })
})

describe('serveCommand', () => {
  const setup = (exists = true) => {
    const out: string[] = []
    const err: string[] = []
    const run = vi.fn(async () => 0)
    const command = serveCommand({
      cwd: '/work/app',
      execPath: '/home/u/.cate/runtime/2.1.0/runtime/bin/node',
      platform: 'linux',
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      exists: () => exists,
      run,
    })
    return { command, run, out, err }
  }

  it('starts the install\'s daemon detached with network on', async () => {
    const { command, run } = setup()
    expect(await command(['--connect'])).toBe(0)
    expect(run).toHaveBeenCalledWith('/home/u/.cate/runtime/2.1.0/runtime/bin/node', [
      '/home/u/.cate/runtime/2.1.0/runtime.cjs', 'serve', '/work/app', '--detach', '--network', 'cateConnect',
    ])
  })

  it('usage errors exit 2 without running anything', async () => {
    const { command, run, err } = setup()
    expect(await command(['--bogus'])).toBe(2)
    expect(run).not.toHaveBeenCalled()
    expect(err).toEqual([
      'cate: unknown option --bogus',
      'Usage: cate serve [<path>] [--connect] [--json]',
      "Run 'cate serve --help' for usage.",
    ])
  })

  it('help prints usage', async () => {
    const { command, out } = setup()
    expect(await command(['--help'])).toBe(0)
    expect(out).toEqual([SERVE_USAGE])
  })

  it('without a runtime install next to it, exits 3', async () => {
    const { command, run } = setup(false)
    expect(await command([])).toBe(3)
    expect(run).not.toHaveBeenCalled()
  })
})
