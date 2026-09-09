import fs from 'node:fs/promises'
import type { SkillFileHost } from './skillWorkspace'

/** App-owned bundled skills and library cache use the same bundle operations
 * as workspace installs, with a local filesystem capability. */
export const localSkillFiles: SkillFileHost = { file: {
  readFile: path => fs.readFile(path, 'utf8'),
  readBinary: path => fs.readFile(path),
  writeFile: (path, text) => fs.writeFile(path, text, 'utf8'),
  writeBinary: (path, bytes) => fs.writeFile(path, bytes),
  mkdir: path => fs.mkdir(path, { recursive: true }),
  remove: path => fs.rm(path, { recursive: true, force: true }),
  rename: (from, to) => fs.rename(from, to),
  stat: async path => { const stat = await fs.stat(path); return { isDirectory: stat.isDirectory(), isFile: stat.isFile() } },
  readDir: async path => (await fs.readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isFile()).map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() })),
} }
