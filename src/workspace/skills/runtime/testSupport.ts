// Test helpers: the agent targets as the composition root would pass them and
// an in-memory filesystem with real directory rename/remove semantics.

import type { SkillTarget } from '../contract'
import type { SkillFiles } from './files'

const folder = (id: string, label: string, base: string, extra: Partial<SkillTarget> = {}): SkillTarget => ({
  id, label, baseSegments: [base, 'skills'], layout: 'folder', bundledResources: true, nameMatchesDir: false, ...extra,
})

export const TEST_TARGETS: SkillTarget[] = [
  folder('claude-code', 'Claude Code', '.claude', { nameMatchesDir: true }),
  folder('codex', 'Codex', '.codex'),
  folder('cursor', 'Cursor', '.cursor'),
  folder('grok', 'Grok', '.grok'),
  folder('opencode', 'OpenCode', '.opencode'),
  folder('hermes', 'Hermes', '.hermes'),
  folder('kiro', 'Kiro', '.kiro', { nameMatchesDir: true }),
]

const norm = (value: string) => value.replace(/\\/g, '/')

export function memorySkillFiles(files: Map<string, string>, dirs: Set<string>, beforeRemove?: (path: string) => void): SkillFiles {
  const exists = (p: string) => dirs.has(p) || [...files.keys()].some(key => key.startsWith(`${p}/`))
  const missing = (p: string): never => { throw new Error(`ENOENT: ${p}`) }
  return {
    readFile: async p => files.get(norm(p)) ?? missing(p),
    readBinary: async p => Buffer.from(files.get(norm(p)) ?? missing(p), 'utf8'),
    writeFile: async (p, text) => { files.set(norm(p), text) },
    writeBinary: async (p, bytes) => { files.set(norm(p), bytes.toString('utf8')) },
    mkdir: async p => { dirs.add(norm(p)) },
    stat: async p => {
      p = norm(p)
      if (files.has(p)) return { isFile: true, isDirectory: false }
      if (exists(p)) return { isFile: false, isDirectory: true }
      return missing(p)
    },
    readDir: async p => {
      p = norm(p)
      if (!exists(p)) return missing(p)
      const entries = new Map<string, { name: string; isDirectory: boolean }>()
      for (const key of [...dirs, ...files.keys()]) {
        if (!key.startsWith(`${p}/`)) continue
        const rel = key.slice(p.length + 1)
        const name = rel.split('/')[0]
        entries.set(name, { name, isDirectory: rel.includes('/') || dirs.has(key) })
      }
      return [...entries.values()]
    },
    remove: async p => {
      p = norm(p)
      beforeRemove?.(p)
      for (const key of [...files.keys()]) if (key === p || key.startsWith(`${p}/`)) files.delete(key)
      for (const key of [...dirs]) if (key === p || key.startsWith(`${p}/`)) dirs.delete(key)
    },
    rename: async (from, to) => {
      from = norm(from); to = norm(to)
      if (!files.has(from) && !exists(from)) return missing(from)
      for (const [key, value] of [...files]) {
        if (key === from || key.startsWith(`${from}/`)) { files.delete(key); files.set(to + key.slice(from.length), value) }
      }
      for (const key of [...dirs]) {
        if (key === from || key.startsWith(`${from}/`)) { dirs.delete(key); dirs.add(to + key.slice(from.length)) }
      }
    },
  }
}
