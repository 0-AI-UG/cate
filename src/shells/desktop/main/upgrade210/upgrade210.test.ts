import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { parseDocument } from '@workspace/document/contract'
import { runtimeIdFromCanonicalRoot } from '@runtime/data/contract'
import { workspaceDataDir } from '@runtime/data/node'
import { contentHash, pathKey, BUFFER_TEXT } from '@workspace/files/contract'
import { createDeviceFiles, type DeviceFiles } from '../deviceFiles'
import { needsUpgrade210, upgrade210 } from './index'

const dirs: string[] = []
const devices: DeviceFiles[] = []
afterEach(() => { devices.forEach(d => d.dispose()); dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })); devices.length = dirs.length = 0 })
function fixture() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cate-upgrade-')))
  dirs.push(tmp)
  const userData = path.join(tmp, 'device')
  const root = path.join(tmp, 'project')
  const home = path.join(tmp, 'home')
  const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
  write(path.join(userData, 'analytics-state.json'), { lastSeenVersion: '2.0.5' })
  write(path.join(userData, 'recent-projects.json'), { projects: [root] })
  write(path.join(userData, 'sidebar.json'), { session: { order: [root], selected: root } })
  write(path.join(userData, 'trusted-projects.json'), { projects: [root] })
  write(path.join(userData, 'settings.json'), { terminalScrollback: 3333, terminalFontSize: 17, cliEnabled: false })
  const tabs = (ids: string[]) => ({ type: 'tabs', id: 'old-tabs', panelIds: ids, activeIndex: 0 })
  const workspace = {
    version: 1, name: 'My project', color: '#123456',
    panels: { canvas: { type: 'canvas', title: 'Canvas' }, term: { type: 'terminal', title: 'Shell' }, edit: { type: 'editor', title: 'File', filePath: 'file.ts' }, browser: { type: 'browser', title: 'Web', tabs: [{ id: 'old-tab', url: 'https://example.com', title: 'Example' }], activeTabId: 'old-tab' }, scratch: { type: 'editor', title: 'Notes' }, oldAgent: { type: 'agent', title: 'T3' } },
    dockState: { zones: { center: { layout: tabs(['canvas']) } } },
    canvases: { canvas: { canvasNodes: { node: { id: 'node', origin: { x: 80, y: -40 }, size: { width: 640, height: 480 }, dockLayout: tabs(['term', 'edit', 'browser', 'scratch', 'oldAgent']) } } } },
  }
  const session = { version: 1, panels: { term: { workingDirectory: root }, edit: { unsavedContent: 'unsaved code', editorBaseline: 'old code' }, scratch: { unsavedContent: 'unsaved notes' } }, panelRelations: [{ id: 'relation', fromPanelId: 'term', toPanelId: 'edit', kind: 'use' }] }
  write(path.join(root, '.cate', 'workspace.json'), workspace)
  write(path.join(root, '.cate', 'session.json'), session)
  fs.writeFileSync(path.join(root, 'file.ts'), 'changed on disk')
  const device = createDeviceFiles(userData)
  devices.push(device)
  const runtimeId = runtimeIdFromCanonicalRoot(root)
  const data = workspaceDataDir(runtimeId, home)
  const warn = vi.fn()
  const decryptPassword = vi.fn(() => 'secret')
  const run = () => upgrade210({ device, version: '2.1.0', home, warn, decryptPassword })
  return { tmp, root, userData, home, data, runtimeId, device, write, run, warn, decryptPassword, workspace, session }
}

it.each(['2.1.0-beta.1', '2.1.0-beta.15', '2.0.3-beta.1', '2.1.0', '2.1.1'])('never imports when the recorded previous version is %s', async previous => {
  const f = fixture()
  f.write(path.join(f.userData, 'analytics-state.json'), { lastSeenVersion: previous })
  expect(needsUpgrade210(f.userData, '2.1.0')).toBe(false)
  await f.run()
  expect(fs.existsSync(f.data)).toBe(false)
  expect(f.device.get('workspaces')).toBeUndefined()
  expect(f.decryptPassword).not.toHaveBeenCalled()
})

it.each(['workspaces.json', 'device-key.json', 'known-runtimes.json'])('leaves beta installations untouched even with stale analytics and legacy files: %s', async file => {
  const f = fixture()
  f.write(path.join(f.userData, file), { beta: 'untouched' })
  await f.run()
  expect(JSON.parse(fs.readFileSync(path.join(f.userData, file), 'utf8'))).toEqual({ beta: 'untouched' })
  expect(fs.existsSync(f.data)).toBe(false)
})

it('does nothing on a fresh install or a different release', async () => {
  const f = fixture()
  expect(needsUpgrade210(f.userData, '2.1.0-beta.16')).toBe(false)
  fs.rmSync(path.join(f.userData, 'analytics-state.json'))
  await f.run()
  expect(fs.existsSync(f.data)).toBe(false)
})

it('imports a 2.0.5 canvas, shared document, browser and recoverable dirty buffers without writing source files', async () => {
  const f = fixture()
  f.write(path.join(f.userData, 'browser-history.json'), { entries: [{ url: 'https://example.com', title: 'Example' }] })
  f.write(path.join(f.userData, 'browser-credentials.json'), { version: 1, credentials: [{ id: 'login', origin: 'https://example.com', username: 'a', encryptedPassword: Buffer.from('encrypted').toString('base64'), importedAt: 123 }] })
  const cookies = path.join(f.userData, 'Partitions', 'browser-shared', 'Cookies')
  fs.mkdirSync(path.dirname(cookies), { recursive: true }); fs.writeFileSync(cookies, 'cookie database')
  fs.mkdirSync(path.join(f.userData, 'TerminalLogs')); fs.writeFileSync(path.join(f.userData, 'TerminalLogs', 'term.scrollback'), 'old screen')
  await f.run()
  const parsed = parseDocument(fs.readFileSync(path.join(f.data, 'document.json'), 'utf8'))
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw Error(parsed.error)
  expect(parsed.doc.canvases.canvas.nodes.node.rect.origin).toEqual({ x: 80, y: -40 })
  expect(parsed.doc.panels.oldAgent).toBeUndefined()
  expect(parsed.doc.relations.relation.kind).toBe('use')
  expect(JSON.parse(fs.readFileSync(path.join(f.data, 'settings.json'), 'utf8'))).toMatchObject({ terminalScrollback: 3333, cliEnabled: false })
  expect(JSON.parse(fs.readFileSync(path.join(f.data, 'sessions', 'browser.json'), 'utf8')).activeTabId).toBe('old-tab')
  expect(JSON.parse(fs.readFileSync(path.join(f.data, 'secrets.json'), 'utf8')).browserPasswords[0]).toMatchObject({ password: 'secret', savedAt: 123 })
  if (process.platform !== 'win32') expect(fs.statSync(path.join(f.data, 'secrets.json')).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(path.join(f.userData, 'Partitions', `ws-${f.runtimeId}`, 'Cookies'), 'utf8')).toBe('cookie database')
  expect(fs.readFileSync(path.join(f.data, 'terminal-logs', 'term.scrollback'), 'utf8')).toBe('old screen')
  const file = path.join(f.root, 'file.ts')
  const binary = fs.readFileSync(path.join(f.data, 'buffers', `${contentHash(pathKey(file)).slice(0, 32)}.bin`))
  const len = binary.readUInt32BE(0)
  expect(JSON.parse(binary.subarray(4, 4 + len).toString())).toMatchObject({ path: file, baseText: 'old code', baseHash: contentHash('old code') })
  const doc = new Y.Doc(); Y.applyUpdate(doc, binary.subarray(4 + len)); expect(doc.getText(BUFFER_TEXT).toString()).toBe('unsaved code'); doc.destroy()
  expect(fs.readFileSync(file, 'utf8')).toBe('changed on disk')
  expect(JSON.parse(fs.readFileSync(path.join(f.root, '.cate', 'session.json'), 'utf8'))).toEqual(f.session)
  expect(f.device.boot().lastWorkspace).toBe(`local:${f.root}`)
  expect(f.device.get('settings')).toMatchObject({ terminalFontSize: 17 })
  // Even clearing the new workspace list does not make the import run twice.
  fs.rmSync(path.join(f.userData, 'workspaces.json'))
  const original = fs.readFileSync(path.join(f.data, 'document.json'), 'utf8')
  await f.run()
  expect(fs.readFileSync(path.join(f.data, 'document.json'), 'utf8')).toBe(original)
  expect(f.decryptPassword).toHaveBeenCalledTimes(1)
})

it('never overwrites an existing runtime document', async () => {
  const f = fixture()
  f.write(path.join(f.data, 'document.json'), { existing: true })
  await f.run()
  expect(JSON.parse(fs.readFileSync(path.join(f.data, 'document.json'), 'utf8'))).toEqual({ existing: true })
})

it('fails without committing a partial workspace and retries safely', async () => {
  const f = fixture()
  f.write(path.join(f.root, '.cate', 'workspace.json'), { ...f.workspace, canvases: { canvas: { canvasNodes: { bad: { dockLayout: { type: 'tabs', panelIds: ['term'] } } } } } })
  await expect(f.run()).rejects.toThrow('Cannot import layout')
  expect(fs.existsSync(f.data)).toBe(false)
  expect(fs.existsSync(path.join(f.userData, 'upgrade-2.1.0.json'))).toBe(false)
  f.write(path.join(f.root, '.cate', 'workspace.json'), f.workspace)
  await f.run()
  expect(fs.existsSync(path.join(f.data, 'document.json'))).toBe(true)
})

it('does not read repository-owned state or transfer trust for an untrusted project', async () => {
  const f = fixture()
  f.write(path.join(f.userData, 'trusted-projects.json'), { projects: [] })
  fs.writeFileSync(path.join(f.root, '.cate', 'workspace.json'), 'broken')
  await f.run()
  expect(fs.existsSync(f.data)).toBe(false)
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('Untrusted workspace'))
})

it('the production buffer service restores imported edits and flags disk conflicts', async () => {
  const f = fixture()
  await f.run()
  const { createBufferService, createPathScope } = await import('@workspace/files/runtime')
  const { KeyedLock } = await import('@kernel/state/contract')
  const paths = createPathScope({ root: f.root, dataDir: f.data })
  const buffers = createBufferService({ paths, dir: path.join(f.data, 'buffers'), lock: new KeyedLock(), watch: () => () => {} })
  try {
    const restored = await buffers.restore()
    expect(restored).toHaveLength(2)
    const file = await buffers.open(path.join(f.root, 'file.ts'))
    expect(file.text.toString()).toBe('unsaved code')
    expect(file.state()).toMatchObject({ dirty: true, conflict: { kind: 'changed' } })
    file.close()
    const scratch = restored.find(p => p.endsWith('.md'))!
    const notes = await buffers.open(scratch)
    expect(notes.text.toString()).toBe('unsaved notes')
    expect(notes.state().dirty).toBe(true)
    notes.close()
  } finally { await buffers.dispose(); paths.dispose() }
})

it('uses old recovery backups when the primary layout is unexpectedly empty and the session is missing', async () => {
  const f = fixture()
  f.write(path.join(f.root, '.cate', 'workspace.json.bak'), f.workspace)
  f.write(path.join(f.root, '.cate', 'session.json.bak'), f.session)
  f.write(path.join(f.root, '.cate', 'workspace.json'), { version: 1, name: 'Empty' })
  fs.rmSync(path.join(f.root, '.cate', 'session.json'))
  await f.run()
  const parsed = parseDocument(fs.readFileSync(path.join(f.data, 'document.json'), 'utf8'))
  expect(parsed.ok && parsed.doc.panels.edit.title).toBe('File')
  expect(fs.readdirSync(path.join(f.data, 'buffers'))).toHaveLength(2)
})
