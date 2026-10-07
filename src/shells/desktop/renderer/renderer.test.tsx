// The desktop renderer booted in jsdom over a fake `window.cateDesktop`: every
// install runs, the window renders, and the client connects to a real
// RpcServer with the document service, receives the document, and renders
// each panel type without throwing, native surfaces through the persistent
// host in their workspace's scope (the canvas view has its own tests).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, PANEL_TYPES } from '@workspace/document/contract'
import { PANEL_DEFINITIONS, freshRecord } from '@panels/definitions'
import { documentStoreFor } from '@client/document'
import { PanelHost } from '../ui/client/host/PanelHost'
import { declaredActions } from '@kernel/interaction'
import { WorkspaceScope, selectWorkspace } from '../ui/app'
import { localWorkspaceId } from '@client/workspaces'
import { App } from './App'
import { bootDesktopClient, type DesktopClient } from './boot'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { RpcServer } from '@kernel/rpc/runtime'
import { workspaceCapability } from '@workspace/lifecycle/contract/capability'
import { documentCapability, presenceCapability } from '@workspace/document/contract/capability'
import { createDocumentService, createPresence, documentCapabilityImpl, presenceCapabilityImpl, type DocumentService } from '@workspace/document/runtime'
import { createFakeDesktop } from './testing'
import { buildMenuModel } from './menuModel'

// Native editors and terminals do not run in jsdom.
vi.mock('monaco-editor', () => {
  const model = () => ({ getValue: () => '', setValue: () => {}, dispose: () => {}, isDisposed: () => false, onDidChangeContent: () => ({ dispose() {} }) })
  const editor = () => ({
    getModel: () => null, setModel: () => {}, layout: () => {}, focus: () => {}, dispose: () => {}, updateOptions: () => {},
    onDidChangeCursorPosition: () => ({ dispose() {} }), onDidFocusEditorText: () => ({ dispose() {} }), addCommand: () => null,
  })
  return {
    Uri: { file: (p: string) => ({ path: p, with: () => ({ path: p }) }) },
    languages: { getLanguages: () => [] },
    KeyMod: {}, KeyCode: {},
    editor: { defineTheme: () => {}, setTheme: () => {}, remeasureFonts: () => {}, getModel: () => null, createModel: model, create: editor, createDiffEditor: editor },
  }
})
vi.mock('y-monaco', () => ({ MonacoBinding: class { destroy() {} } }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    buffer = { active: { viewportY: 0, baseY: 0, getLine: () => undefined } }
    parser = { registerOscHandler: () => ({ dispose() {} }) }
    unicode = { activeVersion: '11' }
    open(parent: HTMLElement) { parent.appendChild(document.createElement('div')) }
    loadAddon() {}
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    write(_data: unknown, cb?: () => void) { cb?.() }
    reset() {}
    focus() {}
    onData() { return { dispose() {} } }
    onResize() { return { dispose() {} } }
    onTitleChange() { return { dispose() {} } }
    onSelectionChange() { return { dispose() {} } }
    resize() {}
    refresh() {}
    scrollToBottom() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext() {} findPrevious() {} clearDecorations() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

/** A runtime with the document and workspace capabilities over a real
 *  document service; trusted from the start. */
interface FakeRuntime {
  server: RpcServer
  document: DocumentService
  root: string
  dispose(): void
}

/** A runtime with a real document service; trusted from the start. */
function createFakeRuntime(): FakeRuntime {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cate-renderer-test-'))
  const lifecycle = createLifecycleBus()
  const document = createDocumentService({ file: path.join(dir, 'document.json') })
  const presence = createPresence({ lifecycle })
  const server = new RpcServer({ version: '9.0.0', lifecycle })
  server.register(documentCapability, documentCapabilityImpl(document, presence))
  server.register(presenceCapability, presenceCapabilityImpl(presence))
  server.register(workspaceCapability, {
    info: () => ({ runtimeId: 'r1', root: dir, name: 'test' }),
    getTrust: () => ({ trusted: true, decidedAt: null }),
    setTrust: ({ trusted }) => ({ trusted, decidedAt: null }),
    watchTrust: () => {},
  })
  return {
    server,
    document,
    root: dir,
    dispose() {
      void server.close()
      document.dispose()
    },
  }
}

const until = async (check: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  }
}

let runtime: FakeRuntime
let client: DesktopClient
let host: HTMLDivElement
let root: Root
let workspaceId: string
const errors: unknown[] = []
const onError = (e: ErrorEvent) => { errors.push(e.error ?? e.message) }

beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.addEventListener('error', onError)
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia
  }
  runtime = createFakeRuntime()
  // One panel of every type, as tabs of the main window.
  for (const type of PANEL_TYPES) {
    const record = freshRecord(runtime.document.get(), type, { title: `A ${type}` }, `p-${type}`)!
    runtime.document.apply({ kind: 'addPanel', record, at: { to: 'stack', dock: { windowId: MAIN_WINDOW, layoutId: 'main' }, stackId: 's1' } })
  }
  workspaceId = localWorkspaceId(runtime.root)
  const desktop = createFakeDesktop({ features: [], runtime: runtime.server })
  client = await bootDesktopClient(desktop.api, { logSink: () => {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterAll(() => {
  if (root) act(() => root.unmount())
  host?.remove()
  client?.dispose()
  runtime?.dispose()
  window.removeEventListener('error', onError)
})

describe('desktop renderer', () => {
  it('boots every install and renders the welcome page without a workspace', async () => {
    await act(async () => root.render(<App client={client} />))
    expect(host.textContent).toContain('Infinite canvas for coding')
    expect(client.window).toEqual({ kind: 'main' })
  })

  it('declares a new-panel action per creatable type and builds the menu bar from the actions', () => {
    const declared = declaredActions().map((a) => a.id)
    for (const definition of PANEL_DEFINITIONS.filter((d) => d.creation)) expect(declared).toContain(`panel.new.${definition.type}`)
    const file = buildMenuModel().bar.find((menu) => menu.id === 'file')!
    const actions = file.items.flatMap((item) => (item.type === 'action' ? [item.action] : []))
    expect(actions).toEqual(expect.arrayContaining(['panel.new.terminal', 'panel.new.editor', 'panel.new.browser', 'openFolder', 'closePanel']))
  })

  it('gives no two declared actions the same default key', () => {
    const keyed = declaredActions().filter(({ spec }) => spec.key?.key)
    const bindings = keyed.map(({ spec }) => JSON.stringify([spec.key!.key, spec.key!.command, spec.key!.shift, spec.key!.option, spec.key!.control]))
    expect(keyed.filter((_, i) => bindings.indexOf(bindings[i]) !== i).map((a) => a.id)).toEqual([])
  })

  it('connects a client with no features to the runtime and receives the document', async () => {
    expect(client.info.features).toEqual([])
    await client.workspaces.addLocal(runtime.root, 'test')
    await act(async () => { await selectWorkspace(workspaceId) })
    await until(() => !!documentStoreFor(workspaceId)?.isSynced())
    expect(Object.keys(documentStoreFor(workspaceId)!.getSnapshot().panels).sort()).toEqual(PANEL_TYPES.map((t) => `p-${t}`).sort())
    await until(() => host.textContent!.includes('A terminal'))
  })

  it('renders every panel type but the canvas, and nothing throws', async () => {
    const types = PANEL_TYPES.filter((type) => type !== 'canvas')
    const panels = document.createElement('div')
    document.body.appendChild(panels)
    const panelsRoot = createRoot(panels)
    await act(async () => panelsRoot.render(
      // As in a window: panel views run inside the workspace's scope.
      <WorkspaceScope workspaceId={workspaceId}>{types.map((type) => <div key={type} data-type={type} style={{ width: 400, height: 300 }}><PanelHost workspaceId={workspaceId} panelId={`p-${type}`} /></div>)}</WorkspaceScope>,
    ))
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    for (const type of types) {
      const cell = panels.querySelector<HTMLElement>(`[data-type="${type}"]`)!
      const text = cell.textContent ?? ''
      expect(text, type).not.toContain('hit an error')
      expect(text, type).not.toContain('Unknown panel type')
    }
    expect(errors).toEqual([])
    act(() => panelsRoot.unmount())
    panels.remove()
  })
})
