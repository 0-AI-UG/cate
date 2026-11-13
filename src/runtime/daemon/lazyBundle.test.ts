import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

// Source-level import() is insufficient: another eager import can pull an
// optional dependency back into every daemon. Check the production graph.
it('keeps optional services outside the initial daemon module graph', async () => {
  const root = path.resolve(__dirname, '../../..')
  const { buildRuntime } = await import(path.join(root, 'scripts/build-runtime.mjs'))
  await fs.mkdir(path.join(root, 'dist-runtime'), { recursive: true })
  const dir = await fs.mkdtemp(path.join(root, 'dist-runtime', 'lazy-bundle-'))
  try {
    const meta = await buildRuntime(path.join(dir, 'runtime.cjs'))
    const eager = new Set<string>()
    const visit = (name: string) => {
      if (eager.has(name)) return
      eager.add(name)
      for (const edge of meta.outputs[name]?.imports ?? []) {
        if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path)
      }
    }
    visit(Object.keys(meta.outputs).find((name) => name.endsWith('/main.mjs'))!)
    expect([...eager].flatMap((name) => meta.outputs[name].imports).some((edge) =>
      edge.path === '@parcel/watcher' && edge.kind !== 'dynamic-import',
    )).toBe(false)
    const initialInputs = [...eager].flatMap((name) => Object.keys(meta.outputs[name].inputs))
    for (const optional of ['registry/skills-index.json', 'yjs/dist', '@xterm/headless', 'tldts/dist', 'runtime/usage/usage.ts']) {
      expect(initialInputs.some((name) => name.includes(optional)), optional).toBe(false)
      expect(Object.keys(meta.inputs).some((name) => name.includes(optional)), optional).toBe(true)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 30_000)

it('keeps an earlier module graph available for deferred imports after a rebuild', async () => {
  const root = path.resolve(__dirname, '../../..')
  const { buildRuntime } = await import(path.join(root, 'scripts/build-runtime.mjs'))
  await fs.mkdir(path.join(root, 'dist-runtime'), { recursive: true })
  const dir = await fs.mkdtemp(path.join(root, 'dist-runtime', 'lazy-rebuild-'))
  try {
    const modules = path.join(dir, 'runtime-modules')
    await fs.mkdir(modules)
    // Stand in for an already loaded entry whose feature chunk belongs to
    // a previous build. Loading the feature must remain possible afterward.
    const entry = path.join(modules, 'previous-entry.mjs')
    await fs.writeFile(entry, "export const load = () => import('./previous-feature.mjs')")
    await fs.writeFile(path.join(modules, 'previous-feature.mjs'), 'export const value = 42')
    const previous = await import(pathToFileURL(entry).href)
    await buildRuntime(path.join(dir, 'runtime.cjs'))
    await expect(previous.load()).resolves.toMatchObject({ value: 42 })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 30_000)
