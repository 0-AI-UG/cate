import path from 'node:path'
import fs from 'node:fs/promises'
import { expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '../../..')

// The order is what keeps a failed PTY spawn a JS error (see loadPty.ts).
it('loads node-pty before @parcel/watcher in the daemon bundle', async () => {
  const { buildRuntime } = await import(path.join(repoRoot, 'scripts/build-runtime.mjs'))
  const dir = await fs.mkdtemp(path.join(repoRoot, 'dist-runtime', 'native-order-'))
  try {
    await buildRuntime(path.join(dir, 'runtime.cjs'))
    const code = await fs.readFile(path.join(dir, 'runtime-modules/main.mjs'), 'utf8')
    const pty = code.indexOf('__require("node-pty")')
    const watcher = code.indexOf('import("@parcel/watcher")')
    expect(pty).toBeGreaterThan(-1)
    expect(watcher).toBeGreaterThan(-1)
    expect(pty).toBeLessThan(watcher)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 30_000)
