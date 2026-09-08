import { expect, it, vi } from 'vitest'
import { readBrowserAX } from './browserAX'

const node = (id: number, role = 'textbox', extra: Record<string, unknown> = {}) => ({
  nodeId: String(id), backendDOMNodeId: id, role: { value: role }, name: { value: `Node ${id}` }, value: { value: `value ${id}` }, ...extra,
})
const visible = { value: { visible: true, offscreen: false, password: false } }

it('bounds inspections to eight and registers in AX order despite out-of-order completion', async () => {
  let active = 0
  let peak = 0
  const releases: Array<() => void> = []
  const register = vi.fn(({ backendNodeId }) => backendNodeId)
  const send = vi.fn(async () => ({ nodes: Array.from({ length: 18 }, (_, i) => node(i + 1)) }))
  const pending = readBrowserAX({ frames: [{ frameId: 'main' }], send, register, callOn: async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>(resolve => releases.push(resolve))
    active--
    return visible
  } })
  await vi.waitFor(() => expect(releases).toHaveLength(8))
  expect(register).not.toHaveBeenCalled()
  while (releases.length || active) {
    releases.splice(0).reverse().forEach(release => release())
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  const result = await pending
  expect(peak).toBe(8)
  expect(result.elements.map(element => element.id)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
  expect(register.mock.calls.map(([target]) => target.backendNodeId)).toEqual(result.elements.map(element => element.id))
  expect(send).toHaveBeenCalledTimes(1)
})

it('masks passwords and unknown password types without separate describeNode calls', async () => {
  const send = vi.fn(async () => ({ nodes: [node(1), node(2, 'searchbox'), node(3)] }))
  const result = await readBrowserAX({ frames: [{}], send, register: target => target.backendNodeId,
    callOn: async target => ({ value: { visible: true, password: target.backendNodeId === 1 ? true : target.backendNodeId === 2 ? undefined : false } }),
  })
  expect(result.elements.map(element => element.value)).toEqual(['••••••••', '••••••••', 'value 3'])
  expect(result.state).not.toContain('value 1')
  expect(result.state).not.toContain('value 2')
  expect(send.mock.calls).toHaveLength(1)
})

it('preserves hierarchy, skips ignored and boxless nodes, and keeps offscreen controls', async () => {
  const result = await readBrowserAX({ frames: [{}], send: async () => ({ nodes: [
    node(2, 'button', { parentId: '1' }), node(1, 'group', { childIds: ['2', '3', '4', '5'] }),
    node(3, 'button', { parentId: '1', ignored: true }), node(4, 'button', { parentId: '1' }), node(5, 'button', { parentId: '1' }),
  ] }), register: target => target.backendNodeId, callOn: async target => ({ value: { visible: target.backendNodeId !== 4, offscreen: target.backendNodeId === 5, password: false } }) })
  expect(result.elements.map(element => element.id)).toEqual([1, 2, 5])
  expect(result.state).toContain('\n  - button "Node 2"')
  expect(result.elements[2].offscreen).toBe(true)
})

it('isolates backend identities by session and tolerates detached frames and nodes', async () => {
  const send = vi.fn(async (_method, _params, sessionId) => {
    if (_params?.frameId === 'detached') throw new Error('frame detached')
    return { nodes: [node(1), node(2)], sessionId }
  })
  const targets: unknown[] = []
  const result = await readBrowserAX({ frames: [{ frameId: 'main' }, { frameId: 'child', sessionId: 'oopif' }, { frameId: 'detached' }], send,
    register: target => { targets.push(target); return targets.length }, callOn: async target => {
      if (target.backendNodeId === 2) throw new Error('node detached')
      return visible
    },
  })
  expect(result.elements).toHaveLength(2)
  expect(targets).toEqual([{ backendNodeId: 1, frameId: 'main', sessionId: undefined }, { backendNodeId: 1, frameId: 'child', sessionId: 'oopif' }])
  expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', {}, 'oopif')
})

it('drains all inspections before propagating registration failure', async () => {
  let active = 0
  const releases: Array<() => void> = []
  const pending = readBrowserAX({ frames: [{}], send: async () => ({ nodes: [node(1), node(2)] }),
    register: () => { expect(active).toBe(0); throw new Error('document changed') }, callOn: async () => {
      active++
      await new Promise<void>(resolve => releases.push(resolve))
      active--
      return visible
    },
  })
  const assertion = expect(pending).rejects.toThrow('document changed')
  await vi.waitFor(() => expect(releases).toHaveLength(2))
  releases.forEach(release => release())
  await assertion
  expect(active).toBe(0)
})

it('uses exactly one inspection per textbox for a large AX tree', async () => {
  const send = vi.fn(async () => ({ nodes: Array.from({ length: 500 }, (_, i) => node(i + 1)) }))
  const callOn = vi.fn(async () => visible)
  const result = await readBrowserAX({ frames: [{}], send, callOn, register: target => target.backendNodeId })
  expect(result.elements).toHaveLength(500)
  expect(callOn).toHaveBeenCalledTimes(500)
  expect(send).toHaveBeenCalledTimes(1)
})

it('inspects native password type, rendered boxes, and viewport in the same function', async () => {
  class Element {
    checkVisibility() { return true }
    getClientRects() { return [{ width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 }] }
  }
  class HTMLInputElement extends Element { type = 'password' }
  const password = new HTMLInputElement()
  const offscreen = new Element()
  offscreen.getClientRects = () => [{ width: 100, height: 20, top: 1000, left: 0, bottom: 1020, right: 100 }]
  const boxless = new Element()
  boxless.getClientRects = () => []
  const targets = [password, offscreen, boxless]
  const result = await readBrowserAX({ frames: [{}], send: async () => ({ nodes: [node(1), node(2, 'button'), node(3, 'button')] }),
    register: target => target.backendNodeId,
    callOn: async (target, declaration) => ({ value: new Function('Element', 'HTMLInputElement', 'innerHeight', 'innerWidth', `return (${declaration})`).call(null, Element, HTMLInputElement, 600, 800).call(targets[target.backendNodeId - 1]) }),
  })
  expect(result.elements.map(element => element.id)).toEqual([1, 2])
  expect(result.elements[0].value).toBe('••••••••')
  expect(result.elements[1].offscreen).toBe(true)
})
