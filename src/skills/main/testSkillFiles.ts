// In-memory filesystem with real directory rename/remove semantics for bundle
// lifecycle tests. Production code only uses the scoped filesystem capability.
import type { SkillFileHost } from './skillWorkspace'
const norm = (value: string) => value.replace(/\\/g, '/')
export function memorySkillFiles(files: Map<string, string>, dirs: Set<string>, beforeRemove?: (path: string) => void): SkillFileHost['file'] {
  const exists = (path: string) => dirs.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`))
  const missing = (path: string): never => { throw new Error(`ENOENT: ${path}`) }
  return {
    readFile: async path => files.get(norm(path)) ?? missing(path),
    readBinary: async path => Buffer.from(files.get(norm(path)) ?? missing(path), 'utf8'),
    writeFile: async (path, text) => { files.set(norm(path), text) },
    writeBinary: async (path, bytes) => { files.set(norm(path), bytes.toString('utf8')) },
    mkdir: async path => { dirs.add(norm(path)) },
    stat: async path => {
      path = norm(path)
      if (files.has(path)) return { isFile: true, isDirectory: false }
      if (exists(path)) return { isFile: false, isDirectory: true }
      return missing(path)
    },
    readDir: async path => {
      path = norm(path)
      if (!exists(path)) return missing(path)
      const entries = new Map<string, { name: string; isDirectory: boolean }>()
      for (const key of [...dirs, ...files.keys()]) {
        if (!key.startsWith(`${path}/`)) continue
        const rel = key.slice(path.length + 1)
        const name = rel.split('/')[0]
        entries.set(name, { name, isDirectory: rel.includes('/') || dirs.has(key) })
      }
      return [...entries.values()]
    },
    remove: async path => {
      path = norm(path)
      beforeRemove?.(path)
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key)
      for (const key of [...dirs]) if (key === path || key.startsWith(`${path}/`)) dirs.delete(key)
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
