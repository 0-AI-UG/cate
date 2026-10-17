import { expect, it, vi } from 'vitest'
import { readBrowserAX } from './ax'

const node = (id: number, role = 'textbox', extra: Record<string, unknown> = {}) => ({
  nodeId: String(id), backendDOMNodeId: id, role: { value: role }, name: { value: `Node ${id}` }, value: { value: `value ${id}` }, ...extra,
})

interface DomNode {
  id: number
  tag?: string
  parent?: number
  attrs?: Record<string, string>
  /** CSS pixels in the document; none: no box. */
  rect?: [number, number, number, number]
  visibility?: string
  opacity?: string
  /** Index of the document this <iframe> shows. */
  content?: number
}

/** A `DOMSnapshot.captureSnapshot` result for documents of DomNodes (by backend id). */
function snapshot(...documents: Array<{ frameId?: string; scrollY?: number; nodes: DomNode[] }>) {
  const strings: string[] = []
  const str = (value: string) => { const at = strings.indexOf(value); return at >= 0 ? at : strings.push(value) - 1 }
  return {
    strings,
    documents: documents.map(doc => {
      const index = new Map(doc.nodes.map((n, i) => [n.id, i]))
      const layout = doc.nodes.flatMap((n, i) => n.rect ? [{ i, n }] : [])
      const content = doc.nodes.flatMap((n, i) => n.content === undefined ? [] : [{ i, value: n.content }])
      return {
        frameId: str(doc.frameId ?? 'main'), scrollOffsetX: 0, scrollOffsetY: (doc.scrollY ?? 0) * 2,
        nodes: {
          parentIndex: doc.nodes.map(n => n.parent === undefined ? -1 : index.get(n.parent)!),
          nodeName: doc.nodes.map(n => str(n.tag ?? 'BUTTON')),
          backendNodeId: doc.nodes.map(n => n.id),
          attributes: doc.nodes.map(n => Object.entries(n.attrs ?? {}).flatMap(([k, v]) => [str(k), str(v)])),
          contentDocumentIndex: { index: content.map(c => c.i), value: content.map(c => c.value) },
        },
        layout: {
          nodeIndex: layout.map(l => l.i),
          // Device pixels, at a device pixel ratio of 2.
          bounds: layout.map(l => l.n.rect!.map(v => v * 2)),
          styles: layout.map(l => [str(l.n.visibility ?? 'visible'), str(l.n.opacity ?? '1')]),
        },
      }
    }),
  }
}

const box: [number, number, number, number] = [0, 0, 100, 20]
const viewport = { width: 800, height: 600, deviceScaleFactor: 2 }
const visibleDom = (...ids: number[]) => snapshot({ nodes: ids.map(id => ({ id, rect: box })) })

function cdp(trees: Record<string, unknown>, snapshots: Record<string, unknown>, owners: Record<string, number> = {}) {
  return vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> => {
    if (method === 'Accessibility.getFullAXTree') {
      const key = sessionId ?? String(params.frameId ?? 'main')
      if (!(key in trees)) throw new Error('frame detached')
      return { nodes: trees[key] }
    }
    if (method === 'DOMSnapshot.captureSnapshot') return snapshots[sessionId ?? 'root'] as Record<string, unknown>
    if (method === 'DOM.getFrameOwner') return { backendNodeId: owners[String(params.frameId)] }
    throw new Error(`unexpected ${method}`)
  })
}

it('inspects every element of a large tree with one DOM snapshot and no per-element calls', async () => {
  const send = cdp({ main: Array.from({ length: 500 }, (_, i) => node(i + 1)) }, { root: visibleDom(...Array.from({ length: 500 }, (_, i) => i + 1)) })
  const result = await readBrowserAX({ frames: [{ frameId: 'main' }], viewport, send, register: target => target.backendNodeId })
  expect(result.elements).toHaveLength(500)
  expect(send.mock.calls.map(([method]) => method)).toEqual(['Accessibility.getFullAXTree', 'DOMSnapshot.captureSnapshot'])
})

it('masks password fields and fields the snapshot does not know', async () => {
  const send = cdp({ main: [node(1), node(2, 'searchbox'), node(3), node(4)] }, { root: snapshot({ nodes: [
    { id: 1, tag: 'INPUT', attrs: { type: 'Password' }, rect: box },
    { id: 3, tag: 'INPUT', rect: box },
    { id: 4, tag: 'INPUT', attrs: { type: 'email' }, rect: box },
  ] }) })
  // Node 2 is not in the snapshot: it is left out, not exposed.
  const result = await readBrowserAX({ frames: [{}], viewport, send, register: target => target.backendNodeId })
  expect(result.elements.map(element => element.value)).toEqual(['••••••••', 'value 3', 'value 4'])
  expect(result.state).not.toContain('value 1')
})

it('preserves hierarchy, skips ignored, boxless, hidden and transparent controls, and keeps offscreen ones', async () => {
  const send = cdp({ main: [
    node(2, 'button', { parentId: '1' }), node(1, 'group', { childIds: ['2', '3', '4', '5', '6', '7'] }),
    node(3, 'button', { parentId: '1', ignored: true }), node(4, 'button', { parentId: '1' }), node(5, 'button', { parentId: '1' }),
    node(6, 'button', { parentId: '1' }), node(7, 'button', { parentId: '1' }),
  ] }, { root: snapshot({ scrollY: 100, nodes: [
    { id: 1, tag: 'DIV', rect: [0, 0, 800, 2000] },
    { id: 2, parent: 1, rect: [0, 150, 100, 20] },
    { id: 3, parent: 1, rect: box },
    { id: 4, parent: 1, rect: [0, 0, 0, 0] },
    { id: 5, parent: 1, rect: [0, 1500, 100, 20] },
    { id: 9, tag: 'DIV', parent: 1, rect: box, opacity: '0' },
    { id: 6, parent: 9, rect: box },
    { id: 7, parent: 1, rect: box, visibility: 'hidden' },
  ] }) })
  const result = await readBrowserAX({ frames: [{}], viewport, send, register: target => target.backendNodeId })
  expect(result.elements.map(element => element.id)).toEqual([1, 2, 5])
  expect(result.state).toContain('\n  - button "Node 2"')
  expect(result.elements[1].offscreen).toBeUndefined()
  expect(result.elements[2].offscreen).toBe(true)
})

it('keeps a styled checkbox whose native input hides behind a visible label', async () => {
  const send = cdp({ main: [node(1, 'checkbox'), node(2, 'checkbox'), node(3, 'checkbox')] }, { root: snapshot({ nodes: [
    { id: 10, tag: 'LABEL', rect: box },
    { id: 1, tag: 'INPUT', parent: 10, attrs: { type: 'checkbox' }, rect: [0, 0, 0, 0] },
    { id: 11, tag: 'LABEL', attrs: { for: 'two' }, rect: box },
    { id: 2, tag: 'INPUT', attrs: { type: 'checkbox', id: 'two' }, rect: box, opacity: '0' },
    { id: 3, tag: 'INPUT', attrs: { type: 'checkbox' } },
  ] }) })
  const result = await readBrowserAX({ frames: [{}], viewport, send, register: target => target.backendNodeId })
  expect(result.elements.map(element => element.id)).toEqual([1, 2])
})

it('says what a file input takes', async () => {
  const send = cdp({ main: [node(1, 'button'), node(2, 'button')] }, { root: snapshot({ nodes: [
    { id: 1, tag: 'INPUT', attrs: { type: 'file' }, rect: box },
    { id: 2, tag: 'INPUT', attrs: { type: 'file', multiple: '' }, rect: box },
  ] }) })
  const result = await readBrowserAX({ frames: [{}], viewport, send, register: target => target.backendNodeId })
  expect(result.state).toBe('- button "Node 1" value="value 1" [file input] [id=1]\n- button "Node 2" value="value 2" [file input, multiple] [id=2]')
})

it('isolates backend identities by session and tolerates detached frames', async () => {
  const send = cdp({ main: [node(1), node(2)], oopif: [node(1)] }, { root: visibleDom(1, 2), oopif: visibleDom(1) })
  const targets: unknown[] = []
  const result = await readBrowserAX({
    frames: [{ frameId: 'main' }, { frameId: 'child', sessionId: 'oopif', parentFrameId: 'main' }, { frameId: 'detached', parentFrameId: 'main' }],
    viewport, send, register: target => { targets.push(target); return targets.length },
  })
  expect(result.elements).toHaveLength(3)
  expect(targets).toEqual([
    { backendNodeId: 1, frameId: 'main', sessionId: undefined }, { backendNodeId: 2, frameId: 'main', sessionId: undefined },
    { backendNodeId: 1, frameId: 'child', sessionId: 'oopif' },
  ])
  expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', {}, 'oopif')
})

it('prints each frame under its iframe, an out-of-process one included', async () => {
  const named = (id: number, role: string, name: string, extra: Record<string, unknown> = {}) => ({ nodeId: String(id), backendDOMNodeId: id, role: { value: role }, name: { value: name }, ...extra })
  const send = cdp({
    main: [named(1, 'main', 'Page', { childIds: ['2', '3', '4'] }), named(2, 'Iframe', 'Same', { parentId: '1' }), named(3, 'Iframe', 'Other', { parentId: '1' }), named(4, 'button', 'After', { parentId: '1' })],
    same: [named(20, 'button', 'Inner')],
    oopif: [named(30, 'link', 'Far')],
  }, {
    root: snapshot({ nodes: [{ id: 1, tag: 'MAIN', rect: box }, { id: 2, tag: 'IFRAME', rect: box, content: 1 }, { id: 3, tag: 'IFRAME', rect: box }, { id: 4, rect: box }] }, { frameId: 'same', nodes: [{ id: 20, rect: box }] }),
    oopif: visibleDom(30),
  }, { same: 2, other: 3 })
  const result = await readBrowserAX({
    frames: [{ frameId: 'main' }, { frameId: 'same', parentFrameId: 'main' }, { frameId: 'other', sessionId: 'oopif', parentFrameId: 'main' }],
    viewport, send, register: target => target.backendNodeId,
  })
  expect(result.state).toBe([
    '- main "Page" [id=1]',
    '  - Iframe "Same" [id=2]',
    '    - button "Inner" [id=20]',
    '  - Iframe "Other" [id=3]',
    '    - link "Far" [id=30]',
    '  - button "After" [id=4]',
  ].join('\n'))
})

it('leaves out unnamed containers, list markers, whitespace and text that repeats its owner, and prints only telling states', async () => {
  const named = (id: number, role: string, name: string, extra: Record<string, unknown> = {}) => ({ nodeId: String(id), backendDOMNodeId: id, role: { value: role }, name: { value: name }, ...extra })
  const send = cdp({ main: [
    named(1, 'generic', '', { childIds: ['2', '4', '5', '6', '8'] }),
    named(2, 'link', 'Docs', { parentId: '1', childIds: ['3'] }),
    named(3, 'StaticText', 'Docs', { parentId: '2' }),
    named(4, 'StaticText', ' ', { parentId: '1' }),
    named(5, 'StaticText', 'Some prose', { parentId: '1' }),
    named(6, 'checkbox', 'Remember me', { parentId: '1', properties: [
      { name: 'checked', value: { value: 'false' } }, { name: 'required', value: { value: false } },
      { name: 'readonly', value: { value: false } }, { name: 'focused', value: { value: true } },
    ] }),
    named(8, 'ListMarker', '• ', { parentId: '1' }),
    named(7, 'button', 'Menu', { properties: [{ name: 'expanded', value: { value: false } }, { name: 'level', value: { value: 2 } }] }),
  ] }, { root: visibleDom(2, 6, 7) })
  const result = await readBrowserAX({ frames: [{}], viewport, send, register: target => target.backendNodeId })
  expect(result.state).toBe([
    '- link "Docs" [id=2]',
    '- StaticText "Some prose" [id=5]',
    '- checkbox "Remember me" [focused] [id=6]',
    '- button "Menu" [collapsed] [level=2] [id=7]',
  ].join('\n'))
  // Structured states stay complete for code.
  expect(result.elements.find(element => element.id === 6)?.states).toEqual({ checked: 'false', required: false, readonly: false, focused: true })
})

it('fails the observation when the page itself cannot be snapshotted', async () => {
  const send = vi.fn(async (method: string): Promise<Record<string, unknown>> => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [node(1)] }
    throw new Error('target crashed')
  })
  await expect(readBrowserAX({ frames: [{}], viewport, send, register: target => target.backendNodeId })).rejects.toThrow('target crashed')
})
