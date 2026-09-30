// Electron's sandboxed preload loader can `require` only `electron` (and a few
// polyfilled built-ins), never a chunk file: a shared rollup chunk leaves
// `window.cateDesktop` undefined. All preloads build in one rollup pass, which
// emits a shared chunk as soon as two entries import the same module. So the
// shell's preloads must share no source module with any other preload entry,
// and each must need nothing but the sandbox's modules.

import path from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import config from '../../../../electron.vite.config'

const root = path.resolve(__dirname, '../../../..')
const SHELL_ENTRIES = ['shell', 'shellGuest', 'shellCodeCell'] as const
/** What the sandboxed preload `require` offers. */
const SANDBOX_MODULES = new Set(['electron', 'events', 'timers', 'url'])

const inputs = (config as { preload: { build: { rollupOptions: { input: Record<string, string> } } } }).preload.build.rollupOptions.input

async function bundle(entry: string): Promise<{ code: string; modules: string[] }> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'cjs',
    external: ['electron'],
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'silent',
  })
  const modules = Object.keys(result.metafile.inputs).filter((file) => !file.includes('node_modules'))
  return { code: result.outputFiles[0].text, modules }
}

describe('desktop preloads', () => {
  it('are build entries of the preload bundle', () => {
    expect(inputs.shell).toBe(path.join(root, 'src/shells/desktop/preload/index.ts'))
    expect(inputs.shellGuest).toBe(path.join(root, 'src/services/browser/desktop/preload/guest.ts'))
    expect(inputs.shellCodeCell).toBe(path.join(root, 'src/services/browser/desktop/preload/codeCell.ts'))
  })

  it.each(SHELL_ENTRIES)('%s requires only sandbox modules', async (name) => {
    const { code } = await bundle(inputs[name])
    const required = [...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
    expect(required.filter((id) => !SANDBOX_MODULES.has(id))).toEqual([])
  }, 30_000)

  it('shares no module with another preload entry, so rollup emits no shared chunk', async () => {
    const graphs = Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([name, entry]) => [name, (await bundle(entry)).modules] as const)))
    const overlaps: string[] = []
    for (const name of SHELL_ENTRIES) {
      for (const [other, modules] of Object.entries(graphs)) {
        if (other === name) continue
        for (const module of graphs[name]) if (modules.includes(module)) overlaps.push(`${name} and ${other}: ${module}`)
      }
    }
    expect(overlaps).toEqual([])
  }, 60_000)
})
