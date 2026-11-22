;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NewTabButton } from './NewTabMenu'

it('asks for a new tab when clicked', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onNewTab = vi.fn()
  try {
    act(() => root.render(<NewTabButton onNewTab={onNewTab} />))
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="New Tab"]')!.click())
    expect(onNewTab).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
