import path from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '../../..')

// The order is what keeps a failed PTY spawn a JS error (see loadPty.ts).
it('loads node-pty before @parcel/watcher in the daemon bundle', async () => {
  const { runtimeBuildOptions } = await import(path.join(repoRoot, 'scripts', 'build-runtime.mjs'))
  const out = await build({ ...runtimeBuildOptions, write: false, logLevel: 'silent' })
  const code = out.outputFiles![0].text
  const pty = code.indexOf('require("node-pty")')
  const watcher = code.indexOf('require("@parcel/watcher")')
  expect(pty).toBeGreaterThan(-1)
  expect(watcher).toBeGreaterThan(-1)
  expect(pty).toBeLessThan(watcher)
}, 30_000)
