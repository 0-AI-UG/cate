import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactNode } from 'react'
import { ShimmerText } from './ShimmerText'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ShimmerText', () => {
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
    return host.firstElementChild as HTMLElement
  }

  it('is plain tinted text while inactive', () => {
    const text = render(<ShimmerText active={false} color="#f00">claude</ShimmerText>)
    expect(text.className).not.toContain('cate-shimmer')
    expect(text.style.color).toBe('rgb(255, 0, 0)')
    expect(text.children).toHaveLength(0)
    expect(text.textContent).toBe('claude')
  })

  it('sweeps a hidden copy over the text while active', () => {
    const text = render(<ShimmerText active color="#f00">claude</ShimmerText>)
    expect(text.className).toContain('cate-shimmer')
    expect(text.style.getPropertyValue('--shimmer-dim')).toBe('#f00')
    expect(text.style.getPropertyValue('--shimmer-bright')).toBe('#ffffff')
    const band = text.querySelector('.cate-shimmer-band')!
    expect(band.getAttribute('aria-hidden')).toBe('true')
    expect(band.querySelector('.cate-shimmer-copy')?.textContent).toBe('claude')
  })

  it('keeps the default stops without a color', () => {
    const text = render(<ShimmerText active>claude</ShimmerText>)
    expect(text.style.getPropertyValue('--shimmer-dim')).toBe('')
  })
})
