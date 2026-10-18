import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ShareSlot } from './ShareSlot'

const state = vi.hoisted(() => ({ others: [] as unknown[], network: 'off' }))
vi.mock('../../client/document', () => ({ useOtherClients: () => state.others }))
vi.mock('../../kernel/settings', () => ({ useWorkspaceSetting: () => state.network }))

let host: HTMLDivElement
let root: Root

const render = (isOpen = true, onShare = vi.fn(), onRow = vi.fn()) => {
  act(() => root.render(
    <div onClick={onRow}>
      <ShareSlot workspaceId="ws-1" isOpen={isOpen} isSelected={false} onShare={onShare} />
    </div>,
  ))
  return host.querySelector('button') as HTMLButtonElement
}

const client = (name: string) => ({ clientId: name, device: { name }, attentive: true })

beforeEach(() => {
  state.others = []
  state.network = 'off'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ShareSlot', () => {
  it('offers to share a workspace nobody else can join', () => {
    expect(render().getAttribute('aria-label')).toBe('Share workspace…')
  })

  it('shows who can join a shared workspace', () => {
    state.network = 'cateConnect'
    expect(render().getAttribute('aria-label')).toBe('Shared: paired devices can join from anywhere')
  })

  it('shows the other clients, which win over who can join', () => {
    state.network = 'sameNetwork'
    state.others = [client('Anna Phone')]
    const button = render()
    expect(button.getAttribute('aria-label')).toBe('Also here: Anna Phone')
    expect(button.textContent).toBe('AP')
  })

  it('shows no clients of a closed workspace', () => {
    state.others = [client('Anna Phone')]
    expect(render(false).getAttribute('aria-label')).toBe('Share workspace…')
  })

  it('opens Share without selecting the row', () => {
    const onShare = vi.fn()
    const onRow = vi.fn()
    const button = render(true, onShare, onRow)
    act(() => button.click())
    expect(onShare).toHaveBeenCalledOnce()
    expect(onRow).not.toHaveBeenCalled()
  })
})
