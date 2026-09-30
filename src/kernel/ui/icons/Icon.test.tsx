import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ICON_NAMES, isIconName } from '../contract'
import { Icon } from './Icon'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('renders an svg for every icon name', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  for (const name of ICON_NAMES) {
    act(() => root.render(<Icon name={name} size={14} className="probe" />))
    const svg = host.querySelector('svg')
    expect(svg, name).not.toBeNull()
    expect(svg!.getAttribute('width'), name).toBe('14')
    expect(svg!.getAttribute('class'), name).toContain('probe')
  }
  act(() => root.unmount())
  expect(isIconName('terminal')).toBe(true)
  expect(isIconName('nope')).toBe(false)
})
