import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserStore } from '../stores/browserStore'
import { BrowserHistoryPage } from './BrowserHistoryPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialBrowserState = useBrowserStore.getState()
const removeHistory = vi.fn()
const clearHistory = vi.fn()
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useBrowserStore.setState({
    history: [
      { url: 'https://example.com/docs', title: 'Example docs', lastVisited: 1, visitCount: 2 },
      { url: 'https://cate.dev/', title: 'Cate', lastVisited: 2, visitCount: 1 },
    ],
    removeHistory,
    clearHistory,
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useBrowserStore.setState(initialBrowserState, true)
  vi.restoreAllMocks()
})

function mount(onNavigate = vi.fn()): void {
  act(() => root.render(<BrowserHistoryPage onNavigate={onNavigate} />))
}

describe('BrowserHistoryPage', () => {
  it('renders as a full page and filters visits by title or URL', () => {
    mount()
    const page = host.querySelector('[data-browser-history]')
    expect(page?.classList).toContain('absolute')
    expect(host.textContent).toContain('Example docs')
    expect(host.textContent).toContain('Cate')

    const input = host.querySelector('input[placeholder="Search history"]') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, 'example')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(host.textContent).toContain('Example docs')
    expect(host.textContent).not.toContain('Cate')
  })

  it('navigates to a visit and can remove it', () => {
    const onNavigate = vi.fn()
    mount(onNavigate)

    const visit = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Example docs'))
    act(() => visit?.click())
    expect(onNavigate).toHaveBeenCalledWith('https://example.com/docs')

    const remove = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Example docs from history"]',
    )
    act(() => remove?.click())
    expect(removeHistory).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('clears all history after confirmation', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mount()

    const clear = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Clear history'))
    act(() => clear?.click())

    expect(clearHistory).toHaveBeenCalledOnce()
  })
})
