import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'

vi.mock('electron', () => ({
  app: {
    commandLine: { hasSwitch: vi.fn(() => false), appendSwitch: vi.fn() },
    getPath: vi.fn(() => '/tmp/cate-agent-browser-test'),
  },
}))

import { AgentBrowserService } from './agentBrowser'

function fakeContents() {
  let marker = ''
  const destroyed: Array<() => void> = []
  return {
    contents: {
      id: 42,
      executeJavaScript: vi.fn(async (code: string) => {
        const match = code.match(/value: ("[^"]+")/)
        if (match) marker = JSON.parse(match[1])
      }),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroyed') destroyed.push(callback)
      }),
      getURL: vi.fn(() => 'https://guest.example/'),
      getTitle: vi.fn(() => 'Guest'),
      isLoading: vi.fn(() => false),
    } as any,
    marker: () => marker,
    destroy: () => destroyed.forEach((callback) => callback()),
  }
}

describe('AgentBrowserService', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a cloneable scalar from the webview marker script', async () => {
    const guest = fakeContents()
    let token = ''
    guest.contents.executeJavaScript.mockImplementation(async (code: string) => {
      const match = code.match(/value: ("[^"]+")/)
      if (match) token = JSON.parse(match[1])
      const completion = runInNewContext(code, {})
      if (completion !== null && (typeof completion === 'object' || typeof completion === 'function')) {
        throw new Error('An object could not be cloned.')
      }
      return completion
    })
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab' && args.length === 1) return { tabs: [{ tabId: 't1', type: 'webview' }] }
      if (args[0] === 'eval') return { result: token }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })

    await expect(service.register(guest.contents, 'panel-1', 'tab-1')).resolves.toBeUndefined()
  })

  it('does not deadlock a command when a later registration replaces the binding promise', async () => {
    const guest = fakeContents()
    let token = ''
    let releaseFirstMarker!: () => void
    const firstMarker = new Promise<void>((resolve) => { releaseFirstMarker = resolve })
    let markerCalls = 0
    guest.contents.executeJavaScript.mockImplementation(async (code: string) => {
      const match = code.match(/value: ("[^"]+")/)
      if (match) token = JSON.parse(match[1])
      markerCalls += 1
      if (markerCalls === 1) await firstMarker
      return true
    })
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab' && args.length === 1) return { tabs: [{ tabId: 't1', type: 'webview' }] }
      if (args[0] === 'eval') return { result: token }
      if (args[0] === 'snapshot') return { refs: {}, snapshot: '- document' }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })

    const firstRegistration = service.register(guest.contents, 'panel-1', 'tab-1')
    await vi.waitFor(() => expect(guest.contents.executeJavaScript).toHaveBeenCalledTimes(1))
    const command = service.execute(42, 'readCommand', { command: ['snapshot', '-i'] })
    const laterRegistration = service.register(guest.contents, 'panel-1', 'tab-1')
    releaseFirstMarker()

    const completed = Promise.all([firstRegistration, command, laterRegistration]).then(() => true)
    const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
    await expect(Promise.race([completed, timedOut])).resolves.toBe(true)
  })

  it('binds the exact marked CDP target using the native tab-list command', async () => {
    const guest = fakeContents()
    let selected = ''
    const commands: string[][] = []
    const runner = vi.fn(async (args: string[]) => {
      commands.push(args)
      if (args[0] === 'tab' && args.length === 1) {
        return {
          tabs: [
            { tabId: 't1', type: 'webview', url: 'https://guest.example/' },
            { tabId: 't2', type: 'page', url: 'https://guest.example/' },
          ],
        }
      }
      if (args[0] === 'tab') {
        selected = args[1]
        return {}
      }
      if (args[0] === 'eval') return { result: selected === 't2' ? guest.marker() : null }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })

    await service.register(guest.contents, 'panel-1', 'tab-1')

    expect(commands[0]).toEqual(['connect', '19333'])
    expect(commands).toContainEqual(['tab'])
    expect(commands).not.toContainEqual(['tab', 'list'])
    expect(commands).toContainEqual(['tab', 't1'])
    expect(commands).toContainEqual(['tab', 't2'])
    expect(commands.at(-1)).toEqual(expect.arrayContaining(['eval']))
  })

  it('rebinds when the cached agent-browser tab disappears', async () => {
    const guest = fakeContents()
    let selected = ''
    let liveTab = 't1'
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab' && args.length === 1) {
        return { tabs: [{ tabId: liveTab, type: 'webview' }] }
      }
      if (args[0] === 'tab') {
        if (args[1] !== liveTab) throw new Error(`Tab ${args[1]} not found`)
        selected = args[1]
        return {}
      }
      if (args[0] === 'eval') return { result: selected === liveTab ? guest.marker() : null }
      if (args[0] === 'snapshot') return { refs: {}, snapshot: '- document' }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    await service.register(guest.contents, 'panel-1', 'tab-1')

    liveTab = 't2'

    await expect(service.execute(42, 'readCommand', {
      command: ['snapshot', '-i'],
    })).resolves.toMatchObject({
      result: { snapshot: '- document' },
    })
    expect(runner).toHaveBeenCalledWith(['tab', 't2'])
  })

  it('reconnects to Electron after the agent-browser daemon expires', async () => {
    const guest = fakeContents()
    let connected = false
    let selected = ''
    let connectCalls = 0
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'connect') {
        connected = true
        connectCalls += 1
        return {}
      }
      if (args[0] === 'tab' && args.length === 1) {
        return connected
          ? { tabs: [{ tabId: 't2', type: 'webview' }] }
          : { tabs: [{ tabId: 't1', type: 'page' }] }
      }
      if (args[0] === 'tab') {
        if (!connected || args[1] !== 't2') {
          // A command after idle expiry makes agent-browser auto-launch its
          // own blank page before reporting the stale tab id.
          connected = false
          throw new Error(`Tab ${args[1]} not found`)
        }
        selected = args[1]
        return {}
      }
      if (args[0] === 'eval') {
        return { result: connected && selected === 't2' ? guest.marker() : null }
      }
      if (args[0] === 'snapshot') return { refs: {}, snapshot: '- document' }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    await service.register(guest.contents, 'panel-1', 'tab-1')

    connected = false

    await expect(service.execute(42, 'readCommand', {
      command: ['snapshot', '-i'],
    })).resolves.toMatchObject({
      result: { snapshot: '- document' },
    })
    expect(connectCalls).toBe(2)
  })

  it('wraps engine refs in a Cate observation revision and rejects stale refs', async () => {
    const guest = fakeContents()
    let selected = ''
    let engineRefsLive = false
    const commands: string[][] = []
    const runner = vi.fn(async (args: string[]) => {
      commands.push(args)
      if (args[0] === 'tab' && args.length === 1) return { tabs: [{ tabId: 't9', type: 'webview' }] }
      if (args[0] === 'tab') {
        selected = args[1]
        engineRefsLive = false
        return {}
      }
      if (args[0] === 'eval') return { result: selected === 't9' ? guest.marker() : null }
      if (args[0] === 'snapshot') {
        engineRefsLive = true
        return {
          origin: 'https://guest.example/',
          refs: { e1: { role: 'button', name: 'Save' } },
          snapshot: '- button "Save" [ref=e1]',
        }
      }
      if (args.join(' ') === 'get box @e1') {
        if (!engineRefsLive) throw new Error('Unknown ref: e1')
        return { x: 10, y: 20, width: 80, height: 30 }
      }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    await service.register(guest.contents, 'panel-1', 'tab-1')

    const first = await service.execute(42, 'snapshot', {})
    expect(first.result).toMatchObject({
      snapshotId: 's1',
      snapshot: '- button "Save" [ref=s1e1]',
      refs: [{ ref: '@s1e1', role: 'button', name: 'Save' }],
    })

    const clicked = await service.execute(42, 'click', { ref: '@s1e1' })
    expect(clicked).toMatchObject({
      cursor: { x: 50, y: 35, rect: [10, 20, 80, 30], kind: 'click' },
    })
    expect(commands).toContainEqual(['click', '@e1'])

    const snapshotCommandIndex = commands.findIndex((command) => command[0] === 'snapshot')
    const clickCommandIndex = commands.findIndex((command) => command[0] === 'mouse')
    expect(commands.slice(snapshotCommandIndex + 1, clickCommandIndex))
      .not.toContainEqual(['tab', 't9'])

    await service.execute(42, 'snapshot', {})
    const stale = await service.execute(42, 'click', { ref: '@s1e1' })
    expect(stale).toEqual({ error: 'stale-ref' })
  })

  it('removes destroyed guests from the registry', async () => {
    const guest = fakeContents()
    let selected = ''
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab' && args.length === 1) return { tabs: [{ tabId: 't1', type: 'webview' }] }
      if (args[0] === 'tab') {
        selected = args[1]
        return {}
      }
      if (args[0] === 'eval') return { result: selected === 't1' ? guest.marker() : null }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    await service.register(guest.contents, 'panel-1', 'tab-1')

    guest.destroy()

    await expect(service.execute(42, 'snapshot', {})).resolves.toEqual({
      error: 'agent-browser-target-not-registered',
    })
  })

  it('fills a fallback username field and clears its temporary marker', async () => {
    const guest = fakeContents()
    let selected = ''
    const commands: string[][] = []
    const runner = vi.fn(async (args: string[]) => {
      commands.push(args)
      if (args[0] === 'tab' && args.length === 1) return { tabs: [{ tabId: 't1', type: 'webview' }] }
      if (args[0] === 'tab') {
        selected = args[1]
        return {}
      }
      if (args[0] === 'eval' && args[1].includes("document.querySelectorAll('[data-cate-autofill-target]')")) {
        return { result: { password: true, username: true } }
      }
      if (args[0] === 'eval' && args[1].includes('new InputEvent')) return { result: { value: 'filled' } }
      if (args[0] === 'eval') return { result: selected === 't1' ? guest.marker() : null }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    await service.register(guest.contents, 'panel-1', 'tab-1')

    await expect(service.fillCredential(
      42,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { username: 'person@example.com', password: 'secret', usernameElement: '' },
    )).resolves.toEqual({ ok: true })

    expect(commands.some((command) => command[0] === 'eval'
      && command[1].includes('data-cate-autofill-username-target')
      && command[1].includes('person@example.com'))).toBe(true)
    expect(commands.some((command) => command[0] === 'eval'
      && command[1].includes('data-cate-autofill-target')
      && command[1].includes('secret'))).toBe(true)
    expect(commands.at(-1)?.[0]).toBe('eval')
    expect(commands.at(-1)?.[1]).toContain('removeAttribute')
  })

  it('rejects an autofill marker that no longer points to a password input', async () => {
    const guest = fakeContents()
    let selected = ''
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab' && args.length === 1) return { tabs: [{ tabId: 't1', type: 'webview' }] }
      if (args[0] === 'tab') {
        selected = args[1]
        return {}
      }
      if (args[0] === 'eval' && args[1].includes("document.querySelectorAll('[data-cate-autofill-target]')")) {
        return { result: { password: false, username: false } }
      }
      if (args[0] === 'eval') return { result: selected === 't1' ? guest.marker() : null }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    await service.register(guest.contents, 'panel-1', 'tab-1')

    await expect(service.fillCredential(
      42,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { username: 'person@example.com', password: 'secret', usernameElement: '' },
    )).resolves.toEqual({ error: 'autofill-target-not-password' })
    expect(runner).not.toHaveBeenCalledWith(expect.arrayContaining(['fill']))
  })

  it('forwards native argv, translates revisioned refs, and enforces read envelopes', async () => {
    const guest = fakeContents()
    let selected = ''
    let engineRefsLive = false
    const commands: string[][] = []
    const runner = vi.fn(async (args: string[]) => {
      commands.push(args)
      if (args[0] === 'tab' && args.length === 1) return { tabs: [{ tabId: 't1', type: 'webview' }] }
      if (args[0] === 'tab') {
        selected = args[1]
        engineRefsLive = false
        return {}
      }
      if (args[0] === 'eval') return { result: selected === 't1' ? guest.marker() : null }
      if (args[0] === 'snapshot') {
        engineRefsLive = true
        return {
          refs: { e2: { role: 'button', name: 'Go' } },
          snapshot: '- button "Go" [ref=e2]',
        }
      }
      if (args.join(' ') === 'get box @e2') {
        if (!engineRefsLive) throw new Error('Unknown ref: e2')
        return { x: 1, y: 2, width: 10, height: 20 }
      }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    await service.register(guest.contents, 'panel-1', 'tab-1')

    const snapshot = await service.execute(42, 'readCommand', {
      command: ['snapshot', '-i', '--compact'],
    })
    expect(snapshot.result).toMatchObject({
      snapshotId: 's1',
      snapshot: '- button "Go" [ref=s1e2]',
    })
    expect(commands).toContainEqual(['snapshot', '-i', '--compact'])

    const clicked = await service.execute(42, 'command', {
      command: ['click', '@s1e2'],
    })
    expect(clicked).toMatchObject({
      cursor: { x: 6, y: 12, kind: 'click' },
    })
    expect(commands).toContainEqual(['click', '@e2'])

    await service.execute(42, 'readCommand', {
      command: ['wait', '@s1e2', '--state', 'visible', '--timeout', '3000'],
    })
    expect(commands).toContainEqual(['wait', '@e2', '--timeout', '3000'])

    await expect(service.execute(42, 'readCommand', {
      command: ['click', '@s1e2'],
    })).resolves.toEqual({ error: 'browser-command-requires-control' })
    await expect(service.execute(42, 'command', {
      command: ['tab', 'new'],
    })).resolves.toEqual({ error: 'unsupported-browser-command:tab' })
  })

  it('routes revisioned refs through native agent-browser element actions', async () => {
    const guest = fakeContents()
    let selected = ''
    const commands: string[][] = []
    const runner = vi.fn(async (args: string[]) => {
      commands.push(args)
      if (args[0] === 'tab' && args.length === 1) {
        return { tabs: [{ tabId: 't1', type: 'webview' }] }
      }
      if (args[0] === 'tab') {
        selected = args[1]
        return {}
      }
      if (args[0] === 'eval') return { result: selected === 't1' ? guest.marker() : null }
      if (args[0] === 'snapshot') {
        return {
          refs: {
            e4: { role: 'button', name: 'Login' },
            e5: { role: 'textbox', name: 'Username' },
            e7: { role: 'checkbox', name: 'Remember me' },
            e8: { role: 'generic', name: 'Drop target' },
          },
          snapshot: '- textbox "Username" [ref=e5]\n- button "Login" [ref=e4]',
        }
      }
      if (args[0] === 'get' && args[1] === 'box') {
        return { x: 1.25, y: 2.5, width: 10.5, height: 20.5 }
      }
      if (args[0] === 'get' && args[1] === 'attr') {
        return { value: { '@e4': 'login', '@e5': 'username', '@e7': 'remember', '@e8': 'drop' }[args[2]] }
      }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    const snapshot = await service.register(guest.contents, 'panel-1', 'tab-1')
      .then(() => service.execute(42, 'readCommand', { command: ['snapshot', '-i'] }))

    expect(snapshot.result).toMatchObject({ snapshotId: 's1' })
    const filled = await service.execute(42, 'fill', { ref: '@s1e5', text: 'standard_user' })
    await service.execute(42, 'click', { ref: '@s1e4' })
    await service.execute(42, 'check', { ref: '@s1e7' })
    await service.execute(42, 'drag', { from: '@s1e7', to: '@s1e8' })
    await service.execute(42, 'type', { ref: '@s1e5', text: ' suffix' })
    await service.execute(42, 'command', { command: ['fill', '@s1e5', 'raw fill'] })
    await service.execute(42, 'command', { command: ['type', '@s1e5', ' raw type'] })
    await service.execute(42, 'command', { command: ['click', '@s1e4'] })
    await service.execute(42, 'readCommand', {
      command: ['wait', '@s1e5', '--state', 'visible', '--timeout', '3000'],
    })

    expect(filled.error).toBeUndefined()
    expect(commands.some((command) => command[0] === 'eval'
      && command[1].includes('[id=\\"username\\"]')
      && command[1].includes('standard_user'))).toBe(true)
    expect(commands.some((command) => command[0] === 'eval'
      && command[1].includes('[id=\\"login\\"]')
      && command[1].includes('element.click()'))).toBe(true)
    expect(commands).toContainEqual(['check', '[id="remember"]'])
    expect(commands).toContainEqual(['drag', '[id="remember"]', '[id="drop"]'])
    expect(commands.some((command) => command[0] === 'eval'
      && command[1].includes('[id=\\"username\\"]')
      && command[1].includes('element.value + text')
      && command[1].includes(' suffix'))).toBe(true)
    expect(commands.some((command) => command[0] === 'eval'
      && command[1].includes('[id=\\"username\\"]')
      && command[1].includes('raw fill'))).toBe(true)
    expect(commands.some((command) => command[0] === 'eval'
      && command[1].includes('[id=\\"username\\"]')
      && command[1].includes('element.value + text')
      && command[1].includes(' raw type'))).toBe(true)
    expect(commands.filter((command) => command[0] === 'eval'
      && command[1].includes('[id=\\"login\\"]')
      && command[1].includes('element.click()'))).toHaveLength(2)
    expect(commands).toContainEqual(['wait', '[id="username"]', '--timeout', '3000'])
  })

  it('passes semantic locator actions through without rewriting them', async () => {
    const guest = fakeContents()
    let selected = ''
    const commands: string[][] = []
    const runner = vi.fn(async (args: string[]) => {
      commands.push(args)
      if (args[0] === 'tab' && args.length === 1) {
        return { tabs: [{ tabId: 't1', type: 'webview' }] }
      }
      if (args[0] === 'tab') {
        selected = args[1]
        return {}
      }
      if (args[0] === 'eval') return { result: selected === 't1' ? guest.marker() : null }
      return {}
    })
    const service = new AgentBrowserService({ runner, endpoint: async () => '19333' })
    await service.register(guest.contents, 'panel-1', 'tab-1')

    await service.execute(42, 'command', {
      command: ['find', 'role', 'textbox', 'fill', 'standard_user', '--name', 'Username'],
    })
    await service.execute(42, 'command', {
      command: ['find', 'nth', '2', 'fill', 'click'],
    })

    expect(commands).toContainEqual([
      'find', 'role', 'textbox', 'fill', 'standard_user', '--name', 'Username',
    ])
    expect(commands).toContainEqual(['find', 'nth', '2', 'fill', 'click'])
  })
})
