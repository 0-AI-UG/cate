// Ships only in 2.1.0. Delete this directory and the one main/index.ts call.
// Original 2.0.x files are never changed. No legacy readers reach the runtime.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomicSync } from '@kernel/state/node'
import { runtimeIdFromCanonicalRoot } from '@runtime/data/contract'
import { workspaceDataDir } from '@runtime/data/node'
import { compareSemver, isMachine, machineKey, type Machine } from '@runtime/daemon/contract'
import { BUFFER_TEXT, contentHash, pathKey } from '@workspace/files/contract'
import { workspaceSettingsTable } from '@panels/settings'
import type { DeviceFiles } from '../deviceFiles'
import { convertLayout, object, strings, type Recovery } from './layout'

function read(file: string): Record<string, unknown> {
  try { return object(JSON.parse(fs.readFileSync(file, 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
const exists = (dir: string, file: string) => fs.existsSync(path.join(dir, file))

/** Positive evidence of a stable pre-2.1 install, never absence of new files
 * alone. Analytics records lastSeenVersion even with telemetry disabled. */
export function needsUpgrade210(userData: string, version: string): boolean {
  if (version !== '2.1.0') return false
  if (['upgrade-2.1.0.json', 'workspaces.json', 'known-runtimes.json', 'device-key.json'].some(file => exists(userData, file))) return false
  const previous = read(path.join(userData, 'analytics-state.json')).lastSeenVersion
  return typeof previous === 'string' && /^\d+\.\d+\.\d+$/.test(previous)
    && compareSemver(previous, '2.1.0') < 0
}

function legacyWorkspace(root: string) {
  const file = path.join(root, '.cate', 'workspace.json')
  let current: Record<string, unknown> = {}
  try { current = read(file) } catch { /* the backup may be intact */ }
  const nodes = (w: Record<string, unknown>) => Object.values(object(w.canvases)).reduce<number>((count, value) => count + Object.keys(object(object(value).canvasNodes)).length, 0)
  if (current.version === 1 && (nodes(current) > 0 || current.emptyLayout === true)) return current
  let backup: Record<string, unknown> = {}
  try { backup = read(`${file}.bak`) } catch { /* primary may still be valid */ }
  if (backup.version === 1) return backup
  if (current.version === 1) return current
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return { version: 1, name: path.basename(root) }
  throw new Error(`No readable 2.0 workspace at ${root}`)
}

async function saveRecovery(dir: string, recovery: Recovery[]) {
  if (!recovery.length) return
  const Y = await import('yjs')
  const seen = new Map<string, string>()
  for (const item of recovery) {
    const key = pathKey(item.file)
    if (seen.get(key) === item.content) continue
    if (seen.has(key)) throw new Error(`Multiple different unsaved buffers for ${item.file}; original sessions need review`)
    seen.set(key, item.content)
    let bytes: Buffer | undefined
    try { bytes = fs.readFileSync(item.file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const baseText = item.baseline ?? bytes?.toString('utf8') ?? ''
    const meta = Buffer.from(JSON.stringify({ path: item.file, baseText, baseHash: item.baseline !== undefined ? contentHash(item.baseline) : bytes ? contentHash(bytes) : null }))
    const doc = new Y.Doc()
    doc.getText(BUFFER_TEXT).insert(0, item.content)
    const update = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(meta.length)
    const buffers = path.join(dir, 'buffers')
    fs.mkdirSync(buffers, { recursive: true })
    fs.writeFileSync(path.join(buffers, `${contentHash(key).slice(0, 32)}.bin`), Buffer.concat([header, meta, update]), { mode: 0o600 })
  }
}

function copyBrowserPartition(userData: string, runtimeId: string) {
  const source = path.join(userData, 'Partitions', 'browser-shared')
  const target = path.join(userData, 'Partitions', `ws-${runtimeId}`)
  if (!fs.existsSync(source) || fs.existsSync(target)) return
  // Copy stored site data, not Chromium caches or stale process locks.
  const stage = `${target}.upgrade-${randomUUID()}`
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 })
  try {
    for (const name of ['Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm', 'Network', 'Local Storage', 'IndexedDB', 'Session Storage', 'WebStorage', 'Preferences']) {
      const from = path.join(source, name)
      if (fs.existsSync(from)) fs.cpSync(from, path.join(stage, name), { recursive: true, dereference: false })
    }
    fs.renameSync(stage, target)
  } finally { fs.rmSync(stage, { recursive: true, force: true }) }
}

export interface Upgrade210Options {
  device: DeviceFiles
  version: string
  home?: string
  decryptPassword(value: Buffer): string
  warn(message: string): void
}

export async function upgrade210(options: Upgrade210Options): Promise<void> {
  const { device } = options
  const userData = device.dir
  if (!needsUpgrade210(userData, options.version)) return
  const previous = read(path.join(userData, 'analytics-state.json')).lastSeenVersion
  const sidebar = object(read(path.join(userData, 'sidebar.json')).session)
  const roots = [...new Set([...strings(sidebar.order), ...strings(read(path.join(userData, 'recent-projects.json')).projects)])].filter(root => path.isAbsolute(root))
  const trusted = strings(read(path.join(userData, 'trusted-projects.json')).projects)
  const oldSettings = read(path.join(userData, 'settings.json'))
  const passwords = (Array.isArray(read(path.join(userData, 'browser-credentials.json')).credentials)
    ? read(path.join(userData, 'browser-credentials.json')).credentials as unknown[] : []).map(value => {
      const c = object(value)
      if (typeof c.encryptedPassword !== 'string') throw new Error('Invalid old saved password')
      const rest = { ...c }
      delete rest.encryptedPassword
      delete rest.importedAt
      return { ...rest, password: options.decryptPassword(Buffer.from(c.encryptedPassword, 'base64')), savedAt: c.importedAt ?? 0 }
    })
  const local: Array<{ root: string; name: string; lastOpenedAt: number }> = []
  const warnings: string[] = []
  for (const root of roots) {
    if (!fs.existsSync(root)) { warnings.push(`Missing workspace: ${root}`); continue }
    const canonical = fs.realpathSync(root)
    if (local.some(entry => entry.root === canonical)) continue
    const runtimeId = runtimeIdFromCanonicalRoot(canonical)
    const dir = workspaceDataDir(runtimeId, options.home ?? os.homedir())
    local.push({ root: canonical, name: path.basename(canonical), lastOpenedAt: Date.now() })
    // Never write into any existing 2.1 runtime, including one used by another device.
    if (fs.existsSync(dir)) continue
    if (!trusted.includes(root)) {
      warnings.push(`Untrusted workspace must be reopened manually; old files retained: ${root}`)
      continue
    }
    const workspace = legacyWorkspace(root)
    let session: Record<string, unknown>
    try { session = read(path.join(root, '.cate', 'session.json')) }
    catch { session = read(path.join(root, '.cate', 'session.json.bak')) }
    if (!Object.keys(session).length) session = read(path.join(root, '.cate', 'session.json.bak'))
    if (session.version !== undefined && session.version !== 1) throw new Error(`Unknown session format at ${root}`)
    const converted = convertLayout(canonical, workspace, session)
    local[local.length - 1].name = typeof workspace.name === 'string' ? workspace.name : path.basename(canonical)
    warnings.push(...converted.warnings)
    const stage = `${dir}.upgrade-${randomUUID()}`
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 })
    try {
      for (const [id, state] of Object.entries(converted.sessions)) writeJsonAtomicSync(path.join(stage, 'sessions', `${id}.json`), state, { mode: 0o600 })
      await saveRecovery(stage, converted.recovery)
      writeJsonAtomicSync(path.join(stage, 'settings.json'), workspaceSettingsTable.normalize(oldSettings))
      writeJsonAtomicSync(path.join(stage, 'trust.json'), { trusted: true, decidedAt: Date.now() })
      if (passwords.length) writeJsonAtomicSync(path.join(stage, 'secrets.json'), { browserPasswords: passwords }, { mode: 0o600 })
      for (const [oldName, newName] of [['browser-history.json', 'history.json'], ['browser-bookmarks.json', 'bookmarks.json']]) {
        const value = read(path.join(userData, oldName))
        if (Object.keys(value).length) writeJsonAtomicSync(path.join(stage, 'browser', newName), value)
      }
      for (const record of Object.values(converted.document.panels)) {
        if (record.type !== 'terminal') continue
        for (const suffix of ['.scrollback', '.log', '.prev.log']) {
          const from = path.join(userData, 'TerminalLogs', `${record.id}${suffix}`)
          if (!fs.existsSync(from)) continue
          fs.mkdirSync(path.join(stage, 'terminal-logs'), { recursive: true })
          fs.copyFileSync(from, path.join(stage, 'terminal-logs', `${record.id}${suffix}`))
        }
      }
      writeJsonAtomicSync(path.join(stage, 'document.json'), { version: 1, seq: 0, counters: {}, lastSeen: {}, document: converted.document })
      copyBrowserPartition(userData, runtimeId)
      fs.renameSync(stage, dir)
    } finally { fs.rmSync(stage, { recursive: true, force: true }) }
  }
  // Keep remote connection details so SSH/WSL folders remain discoverable.
  // Their old runtime state stays on the host; no network calls during startup.
  const remoteFile = read(path.join(userData, 'remote-workspaces.json'))
  const machine: Array<{ machine: Machine; root: string; name: string; lastOpenedAt: number }> = []
  for (const value of Array.isArray(remoteFile.workspaces) ? remoteFile.workspaces : []) {
    const entry = object(value)
    const c = object(entry.connection)
    const target = c.kind === 'server' ? { kind: 'ssh', target: { destination: `${typeof c.user === 'string' && c.user ? `${c.user}@` : ''}${c.host}`, ...(c.port ? { port: c.port } : {}) } } : { kind: 'wsl', distro: c.distro }
    const root = c.kind === 'server' ? c.remotePath : c.distroPath
    if (!isMachine(target) || typeof root !== 'string') { warnings.push('An old remote workspace must be reopened manually'); continue }
    machine.push({ machine: target, root, name: path.posix.basename(root), lastOpenedAt: Date.now() })
    warnings.push(`Remote workspace layout remains in its old files on the host: ${root}`)
  }
  const order = [...local.map(w => `local:${w.root}`), ...machine.map(w => `machine:${machineKey(w.machine)}:${w.root}`)]
  device.set('workspaces', { local, machine, paired: [], order, closed: [] })
  const selected = typeof sidebar.selected === 'string' ? local.find(w => w.root === sidebar.selected || (fs.existsSync(sidebar.selected as string) && fs.realpathSync(sidebar.selected as string) === w.root)) : undefined
  if (selected) device.updateBoot({ lastWorkspace: `local:${selected.root}` })
  device.set('ui-state', { ...object(device.get('ui-state')), onboardingCompleted: true })
  device.flushSync()
  writeJsonAtomicSync(path.join(userData, 'upgrade-2.1.0.json'), { from: previous, completedAt: Date.now(), warnings })
  for (const warning of warnings) options.warn(warning)
}
