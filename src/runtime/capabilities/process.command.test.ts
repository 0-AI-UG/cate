import { expect, it } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import { RUNTIME_INSTALL_ROOT_PLACEHOLDER, RUNTIME_NODE_EXECUTABLE } from '../../main/runtime/types'
import { installRoot } from '../installRoot'
import { createProcessCapability } from './process'

it('resolves bundled Node and install paths for trusted PTY commands', async () => {
  const capability = createProcessCapability({
    resolveShell: () => ({ path: '/bin/sh', args: ['-l'] }),
    // Windows Node needs system environment variables such as SystemRoot.
    getEnv: () => ({ ...process.env }) as Record<string, string>,
  })
  let output = ''
  let exited!: (code: number) => void
  const exit = new Promise<number>((resolve) => { exited = resolve })
  const handle = await capability.create({
    cols: 1024, rows: 30, cwd: process.cwd(),
    command: {
      executable: RUNTIME_NODE_EXECUTABLE,
      args: ['-e', 'console.log(JSON.stringify([process.execPath, ...process.argv.slice(1)]))',
        `${RUNTIME_INSTALL_ROOT_PLACEHOLDER}/t3/dist/bin.mjs`, 'connect', 'status', '--json'],
    },
  }, (_id, data) => { output += data }, (_id, code) => { exited(code) })
  try {
    expect(await exit, output).toBe(0)
    expect(JSON.parse(stripVTControlCharacters(output).trim())).toEqual([
      process.execPath, `${installRoot()}/t3/dist/bin.mjs`, 'connect', 'status', '--json',
    ])
    expect(handle.shell).toBe(process.execPath)
  } finally {
    capability.kill(handle.id)
  }
})
