import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactNode } from 'react'
import { LoadingState, Spinner } from './Spinner'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Spinner', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    if (root) act(() => root?.unmount())
    host?.remove()
    host = null
    root = null
  })

  function render(node: ReactNode) {
    host = document.createElement('div')
    document.body.appendChild(host)
    const renderRoot = createRoot(host)
    root = renderRoot
    act(() => renderRoot.render(node))
    return host
  }

  it('owns the shared spin and reduced-motion treatment', () => {
    const view = render(<Spinner size={20} />)
    const icon = view.querySelector('svg')
    expect(icon?.classList.contains('animate-spin')).toBe(true)
    expect(icon?.classList.contains('motion-reduce:animate-none')).toBe(true)
  })

  it('renders an accessible labelled loading state', () => {
    const view = render(<LoadingState label="Loading canvas…" />)
    const status = view.querySelector('[role="status"]')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.getAttribute('aria-busy')).toBe('true')
    expect(status?.textContent).toContain('Loading canvas…')
  })
})
