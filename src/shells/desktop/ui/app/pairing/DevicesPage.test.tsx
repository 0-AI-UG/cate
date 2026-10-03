import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent, RuntimeProxy } from '@kernel/rpc/contract'
import { workspaceSettingsTable, type WorkspaceSettings } from '@kernel/settings/contract'
import { installMockClientUi } from '@kernel/interaction/testing'
import type { PairedDevice } from '@runtime/pairing/contract'
import { DevicesPage, formatCountdown } from './DevicesPage'

type Event = ChannelEvent<WorkspaceSettings, Partial<WorkspaceSettings>>

let host: HTMLDivElement
let root: Root
let uninstall: () => void

function fakeRuntime() {
  const watchers = new Set<(list: PairedDevice[]) => void>()
  let listener: ((e: Event) => void) | null = null
  let rev = 0
  let devices: PairedDevice[] = [
    { publicKey: 'aa', fingerprint: 'fp-phone', name: 'Anton phone', pairedAt: 1, lastSeen: 2 },
  ]
  const calls: string[] = []
  const runtime = {
    settings: {
      set: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
        calls.push(`set ${key}=${String(value)}`)
        listener?.({ kind: 'change', rev: ++rev, change: { [key]: value } })
      }),
      subscribe: () => ({
        onEvent: (l: (e: Event) => void) => {
          listener = l
          queueMicrotask(() => l({ kind: 'snapshot', rev, snapshot: { ...workspaceSettingsTable.defaults } }))
          return () => { listener = null }
        },
        cancel: () => {},
      }),
    },
    pairing: {
      createSecret: vi.fn(async ({ mode }: { mode: string }) => {
        calls.push(`createSecret ${mode}`)
        return { uri: 'cate://pair?r=abcdefghijklmnop', code: 'abcd-efgh-ijkl-mnop-qrst-uvwx-yz23-4567', expiresAt: Date.now() + 600_000 }
      }),
      // The runtime sends the list, then again on every change.
      watch: vi.fn(() => ({
        onEvent: (l: (list: PairedDevice[]) => void) => {
          watchers.add(l)
          queueMicrotask(() => l(devices))
          return () => watchers.delete(l)
        },
        done: new Promise(() => {}),
        cancel: () => watchers.clear(),
      })),
      revoke: vi.fn(async ({ deviceKey }: { deviceKey: string }) => {
        devices = devices.filter((d) => d.publicKey !== deviceKey)
        for (const l of watchers) l(devices)
        return { removed: true }
      }),
    },
  } as unknown as RuntimeProxy
  return { runtime, calls }
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  uninstall()
})

describe('DevicesPage', () => {
  it('turns network access on before creating a code, then shows the code, QR and expiry', async () => {
    const { runtime, calls } = fakeRuntime()
    uninstall = setRuntimeResolver((id) => (id === 'w1' ? runtime : null))
    installMockClientUi()
    act(() => root.render(<DevicesPage workspaceId="w1" />))
    await flush()
    const add = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Add device'))!
    await act(async () => { add.click() })
    await flush()
    expect(calls).toEqual(['set runtimeNetwork=sameNetwork', 'createSecret sameNetwork'])
    expect(host.textContent).toContain('ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567')
    expect(host.textContent).toMatch(/Expires in (9:59|10:00)/)
    expect(host.querySelector('[data-testid="pairing-qr"] svg')).not.toBeNull()
  })

  it('lists paired devices and revokes after confirmation', async () => {
    const { runtime } = fakeRuntime()
    uninstall = setRuntimeResolver(() => runtime)
    const ui = installMockClientUi({ confirm: vi.fn(async () => true) })
    act(() => root.render(<DevicesPage workspaceId="w1" />))
    await flush()
    expect(host.textContent).toContain('Anton phone')
    await act(async () => { (host.querySelector('[aria-label="Remove Anton phone"]') as HTMLButtonElement).click() })
    await flush()
    expect(ui.confirm).toHaveBeenCalled()
    expect(runtime.pairing.revoke).toHaveBeenCalledWith({ deviceKey: 'aa' })
    expect(host.textContent).toContain('No other device can open this workspace.')
  })

  it('formats the countdown', () => {
    expect(formatCountdown(599)).toBe('9:59')
    expect(formatCountdown(5)).toBe('0:05')
  })
})
