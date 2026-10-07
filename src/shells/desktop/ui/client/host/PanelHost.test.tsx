import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { add, attachTestWorkspace, buildDocument, fakeSessions, testPanelDefinitions, type FakeSessions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { registerPanelDefinitions } from '@client/host'
import { PanelHost } from './PanelHost'
import { PersistentPanelHost } from './PersistentPanelHost'
import { installSessionSource } from '@client/host'
import { registerPanelView, type PanelViewProps } from './views'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const seen: PanelViewProps[] = []
function TerminalView(props: PanelViewProps<{ text: string }>) {
  seen.push(props as PanelViewProps)
  return <div data-testid="view">{props.snapshot?.text ?? 'empty'}</div>
}

const ScopeContext = React.createContext<string | null>(null)
function BrowserView() {
  return <div data-testid="browser">{React.useContext(ScopeContext) ?? 'no scope'}</div>
}

beforeAll(() => {
  registerPanelDefinitions(testPanelDefinitions())
  registerPanelView('terminal', async () => ({ default: TerminalView as React.ComponentType<PanelViewProps> }))
  registerPanelView('browser', async () => ({ default: BrowserView as React.ComponentType<PanelViewProps> }))
})

const main = { windowId: MAIN_WINDOW, layoutId: 'main' }
let ws: TestWorkspace
let sessions: FakeSessions
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  seen.length = 0
  ws = attachTestWorkspace('w', buildDocument([
    add('t1', { to: 'stack', dock: main, stackId: 's1' }),
    add('b1', { to: 'stack', dock: main, stackId: 's1' }, 'browser'),
    add('odd', { to: 'stack', dock: main, stackId: 's1' }, 'review'),
  ]))
  sessions = fakeSessions()
  installSessionSource(sessions.source)
  installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: [] }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ws.detach()
  installSessionSource(null)
  installClientIdentity(null)
})

async function render(element: React.ReactElement) {
  await act(async () => { root.render(element) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe('PanelHost', () => {
  it('attaches the view to its session and feeds it snapshots', async () => {
    await render(<PanelHost workspaceId="w" panelId="t1" />)
    expect(sessions.refs('t1')).toBe(1)
    expect(container.textContent).toBe('empty')
    act(() => sessions.publish('t1', { text: 'hello' }))
    expect(container.textContent).toBe('hello')
    const props = seen[seen.length - 1]
    expect(props).toMatchObject({ workspaceId: 'w', panelId: 't1', visible: true, focused: false })
    await props.send({ kind: 'ping' })
    expect(sessions.sent).toEqual([{ panelId: 't1', op: { kind: 'ping' } }])
  })

  it('keeps the view and its session when another workspace connects', async () => {
    let connectionsChanged = () => {}
    installSessionSource({ ...sessions.source, subscribe: (listener) => { connectionsChanged = listener; return () => {} } })
    await render(<PanelHost workspaceId="w" panelId="t1" />)
    const view = container.querySelector('[data-testid="view"]')
    expect(view).not.toBeNull()
    act(() => connectionsChanged())
    expect(container.querySelector('[data-testid="view"]')).toBe(view)
    expect(sessions.refs('t1')).toBe(1)
  })

  it('releases the session when the view unmounts', async () => {
    await render(<PanelHost workspaceId="w" panelId="t1" />)
    await render(<div />)
    expect(sessions.refs('t1')).toBe(0)
  })

  it('shows a placeholder for a type this build does not know', async () => {
    await render(<PanelHost workspaceId="w" panelId="odd" />)
    expect(container.textContent).toContain('Unknown panel type')
  })

  it('renders nothing for a missing record', async () => {
    await render(<PanelHost workspaceId="w" panelId="gone" />)
    expect(container.innerHTML).toBe('')
  })

  it('a surface type renders only its geometry slot here', async () => {
    installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: ['webview'] }))
    await render(<PanelHost workspaceId="w" panelId="b1" />)
    expect(container.querySelector('[data-browser-surface-slot="b1"]')).not.toBeNull()
  })

  it('renders each workspace\'s native surfaces inside that workspace\'s scope', async () => {
    const Scope = ({ workspaceId, children }: { workspaceId: string; children: React.ReactNode }) => (
      <ScopeContext.Provider value={`scope of ${workspaceId}`}>{children}</ScopeContext.Provider>
    )
    await render(<PersistentPanelHost workspaceIds={['w']} activeWorkspaceId="w" windowId={MAIN_WINDOW} Scope={Scope} />)
    expect(document.querySelector('[data-testid="browser"]')?.textContent).toBe('scope of w')
  })
})
