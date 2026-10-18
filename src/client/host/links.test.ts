import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { canvasOf, placementOf } from '@workspace/document/contract'
import { installMockClientUi } from '../../test/clientUi'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../test/clientWorkspace'
import { registerPanelDefinitions } from './definitions'
import { openLink } from './links'
import { installCanvasTargetPicker, type CanvasTargetRequest } from './panelTargetPicker'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions().map((definition) => definition.type === 'editor'
  ? { ...definition, fields: (options) => ({ filePath: options.filePath }), checkoutPath: (record) => record.fields.filePath as string | undefined }
  : definition)))

const main = { layoutId: 'main' }
const rect = { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } }

/** A terminal docked in the main window, and one on a docked canvas. */
const fixture = () => buildDocument([
  add('t1', { to: 'stack', dock: main, stackId: 's1' }, 'terminal'),
  add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
  add('t2', { to: 'canvas', canvasId: 'C', nodeId: 'N1', layoutId: 'nl1', stackId: 'ns1', rect }),
  add('e1', { to: 'stack', dock: main, stackId: 's1' }, 'editor', { fields: { filePath: '/repo/open.ts' } }),
])

let ws: TestWorkspace | null = null
const ops = vi.fn(async () => undefined)
afterEach(() => {
  ws?.detach()
  ws = null
  installCanvasTargetPicker(null)
  setRuntimeResolver(null)
  ops.mockClear()
})

function attach(): TestWorkspace {
  ws = attachTestWorkspace('w', fixture())
  setRuntimeResolver(() => ({ session: { op: ops } }) as unknown as RuntimeProxy)
  return ws
}

const newOf = (w: TestWorkspace, type: string) => Object.values(w.confirmed().panels).filter((panel) => panel.type === type)

describe('openLink', () => {
  it('opens a web URL in a panel placed from the panel it was clicked in', async () => {
    const w = attach()
    expect(await openLink('w', { kind: 'url', url: 'https://example.com' }, { from: 't1' })).toBe(true)
    const [browser] = newOf(w, 'browser')
    expect(canvasOf(w.confirmed(), browser.id)).toBeNull()
    expect(placementOf(w.confirmed(), browser.id)).not.toBeNull()
  })

  it('places from a source on a canvas through the canvas picker, on that canvas', async () => {
    const w = attach()
    const requests: CanvasTargetRequest[] = []
    installCanvasTargetPicker({
      pick: async (request) => {
        requests.push(request)
        return { kind: 'new', point: { x: 500, y: 0 }, size: { width: 300, height: 200 } }
      },
    })
    await openLink('w', { kind: 'url', url: 'https://example.com' }, { from: 't2' })
    expect(requests).toMatchObject([{ canvasId: 'C', sourcePanelId: 't2', panelType: 'browser' }])
    const [browser] = newOf(w, 'browser')
    expect(canvasOf(w.confirmed(), browser.id)).toBe('C')
  })

  it('sends a web URL to the system browser when asked, but never a loopback URL', async () => {
    const ui = installMockClientUi()
    const w = attach()
    await openLink('w', { kind: 'url', url: 'https://example.com/x' }, { from: 't1', external: true })
    expect(ui.openExternal).toHaveBeenCalledWith('https://example.com/x')
    expect(newOf(w, 'browser')).toEqual([])
    await openLink('w', { kind: 'url', url: 'http://localhost:3000/' }, { from: 't1', external: true })
    expect(ui.openExternal).toHaveBeenCalledTimes(1)
    expect(newOf(w, 'browser')).toHaveLength(1)
  })

  it('opens a file in a new editor placed from the source, at its line', async () => {
    const w = attach()
    await openLink('w', { kind: 'file', path: '/repo/a.ts', line: 12, column: 5 }, { from: 't1' })
    const editor = newOf(w, 'editor').find((panel) => panel.fields.filePath === '/repo/a.ts')!
    expect(canvasOf(w.confirmed(), editor.id)).toBeNull()
    expect(placementOf(w.confirmed(), editor.id)).not.toBeNull()
    expect(ops).toHaveBeenCalledWith({ panelId: editor.id, op: { kind: 'openFile', path: '/repo/a.ts', line: 12, column: 5 } })
  })

  it('reuses the panel already showing a file', async () => {
    const w = attach()
    await openLink('w', { kind: 'file', path: '/repo/open.ts', line: 3 }, { from: 't2' })
    expect(newOf(w, 'editor')).toHaveLength(1)
    expect(ops).toHaveBeenCalledWith({ panelId: 'e1', op: { kind: 'openFile', path: '/repo/open.ts', line: 3, column: 1 } })
    expect(w.state.getSnapshot().activeTabs.s1).toBe('e1')
  })
})
