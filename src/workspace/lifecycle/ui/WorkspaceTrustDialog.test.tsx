import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTrustStore, type TrustApi } from './trustStore'
import { WorkspaceTrustDialog } from './WorkspaceTrustDialog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function setup() {
  const setTrust = vi.fn(async () => ({ trusted: true, decidedAt: null }))
  const api = { getTrust: async () => ({ trusted: false, decidedAt: null }), setTrust } as unknown as TrustApi
  const store = createTrustStore(() => api)
  act(() => root.render(<WorkspaceTrustDialog store={store} />))
  return { store, setTrust }
}

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement

describe('WorkspaceTrustDialog', () => {
  it('renders nothing without a question', () => {
    setup()
    expect(document.body.textContent).not.toContain('Do you trust this project?')
  })

  it('shows the asking workspace and trusts it on the primary button', async () => {
    const { store, setTrust } = setup()
    let gate!: Promise<boolean>
    await act(async () => { gate = store.ensureTrusted('ws', '/Users/me/repo') })
    expect(document.body.textContent).toContain('/Users/me/repo')
    // The safe answer holds focus.
    expect(document.activeElement?.textContent).toBe('Don\'t open')
    await act(async () => { button('Trust and open').click() })
    await expect(gate).resolves.toBe(true)
    expect(setTrust).toHaveBeenCalledWith({ trusted: true })
    expect(document.body.textContent).not.toContain('Do you trust this project?')
  })

  it('shows why trusting failed and lets the person retry', async () => {
    const { store, setTrust } = setup()
    setTrust.mockRejectedValueOnce(new Error('The runtime did not answer'))
    let gate!: Promise<boolean>
    await act(async () => { gate = store.ensureTrusted('ws', '/repo') })
    await act(async () => { button('Trust and open').click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('The runtime did not answer')
    expect(document.body.textContent).toContain('Do you trust this project?')
    await act(async () => { button('Trust and open').click() })
    await expect(gate).resolves.toBe(true)
    expect(setTrust).toHaveBeenCalledTimes(2)
  })

  it('declines on the secondary button', async () => {
    const { store, setTrust } = setup()
    let gate!: Promise<boolean>
    await act(async () => { gate = store.ensureTrusted('ws', '/repo') })
    await act(async () => { button('Don\'t open').click() })
    await expect(gate).resolves.toBe(false)
    expect(setTrust).not.toHaveBeenCalled()
  })
})
