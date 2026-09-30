import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { setRuntimeResolver } from '@kernel/rpc/client'
import { useWorkspaceRoot } from '.'

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

function Probe({ id }: { id: string }) {
  return <span>{useWorkspaceRoot(id) || 'unknown'}</span>
}

describe('useWorkspaceRoot', () => {
  it('reports the runtime canonical root once its runtime appears', async () => {
    const host = document.createElement('div')
    root = createRoot(host)
    await act(async () => root!.render(<Probe id="local:/tmp/p" />))
    expect(host.textContent).toBe('unknown')
    const runtime = { workspace: { info: async () => ({ root: '/private/tmp/p' }) } } as unknown as RuntimeProxy
    const uninstall = setRuntimeResolver(() => runtime)
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toBe('/private/tmp/p')
    uninstall()
  })
})
