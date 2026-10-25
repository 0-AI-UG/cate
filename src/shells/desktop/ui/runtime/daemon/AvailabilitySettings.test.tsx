;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  info: vi.fn(),
  set: vi.fn(async () => {}),
  triggers: [] as string[],
  devices: [] as { name: string; admittedBy: string }[],
}))
const runtime = vi.hoisted(() => ({
  runtime: { info: h.info },
  pairing: {
    watch: () => ({
      onEvent: (fn: (e: unknown) => void) => fn({ kind: 'snapshot', snapshot: h.devices }),
      done: new Promise(() => {}),
      cancel: () => {},
    }),
  },
}))
vi.mock('../../kernel/rpc', () => ({ useRuntime: () => runtime }))
vi.mock('../../kernel/settings', () => ({
  useWorkspaceSetting: () => h.triggers,
  setWorkspaceSetting: h.set,
}))

import { AvailabilitySettings } from './AvailabilitySettings'

const laptop = { version: '1.0.0', protocol: [1, 0], pid: 1, clients: [], machineName: 'MacBook', machineSleeps: true }
const server = { ...laptop, machineName: 'vps-1', machineSleeps: false }

beforeEach(() => {
  h.info.mockReset()
  h.set.mockClear()
  h.triggers = ['agents', 'commands', 'clients']
  h.devices = []
})

async function render(run: (host: HTMLElement) => Promise<void>, props: { onAddDevice?: () => void } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AvailabilitySettings workspaceId="ws" {...props} />))
    await run(host)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
}

const select = (host: HTMLElement) => host.querySelector('select')!
const options = (host: HTMLElement) => [...select(host).options].map((o) => o.textContent)
const pick = (host: HTMLElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select(host), value)
  select(host).dispatchEvent(new Event('change', { bubbles: true }))
})

it('on a laptop: finish comes first, picks store triggers, the toggle drops commands', async () => {
  h.info.mockResolvedValue(laptop)
  await render(async (host) => {
    expect(host.textContent).toContain('Running on MacBook')
    expect(options(host)).toEqual(['Finish what\'s running, then stop', 'Always stay available', 'Stop with Cate'])
    expect(select(host).value).toBe('finish')
    expect(host.textContent).toContain('MacBook stays awake')

    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    expect(h.set).toHaveBeenLastCalledWith('ws', 'keepRunningWhile', ['agents', 'clients'])

    await pick(host, 'stop')
    expect(h.set).toHaveBeenLastCalledWith('ws', 'keepRunningWhile', ['clients'])
  })
})

it('on a server: always comes first and is recommended, with no talk of sleep', async () => {
  h.info.mockResolvedValue(server)
  await render(async (host) => {
    expect(host.textContent).toContain('Running on vps-1 (server)')
    expect(options(host)[0]).toBe('Always stay available (recommended)')
    expect(host.textContent).not.toMatch(/awake|battery/)
  })
})

it('warns that paired devices lose the workspace once it stops, until it stays available', async () => {
  h.info.mockResolvedValue(laptop)
  h.devices = [{ name: 'iPhone', admittedBy: 'pairing' }, { name: 'MacBook', admittedBy: 'machineUser' }]
  await render(async (host) => {
    expect(host.textContent).toContain('iPhone cannot connect once the workspace stops or MacBook sleeps')
    const stay = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Stay available')!
    await act(async () => stay.click())
    expect(h.set).toHaveBeenLastCalledWith('ws', 'keepRunningWhile', ['always'])
  })
})

it('offers adding a device when none is paired, and names a custom list', async () => {
  h.info.mockResolvedValue(laptop)
  h.triggers = ['commands']
  const onAddDevice = vi.fn()
  await render(async (host) => {
    expect(select(host).value).toBe('custom')
    expect(host.textContent).toContain('Set by hand in this workspace\'s settings.json')
    const add = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add a device')!
    await act(async () => add.click())
    expect(onAddDevice).toHaveBeenCalled()
  }, { onAddDevice })
})

it('replaces the spinner with the error and a retry when the runtime does not answer', async () => {
  h.info.mockRejectedValueOnce(new Error('runtime unreachable'))
  await render(async (host) => {
    expect(host.querySelector('.animate-spin')).toBeNull()
    expect(host.textContent).toContain('runtime unreachable')
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!

    h.info.mockResolvedValueOnce({ ...laptop, version: '9.9.9' })
    await act(async () => retry.click())
    expect(h.info).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Cate 9.9.9')
    expect(host.textContent).not.toContain('Retry')
  })
})
