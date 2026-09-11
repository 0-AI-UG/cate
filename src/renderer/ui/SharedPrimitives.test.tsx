import { act, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from './Button'
import { Modal } from './Modal'
import { POPOVER_SURFACE, useDismissableLayer } from './Popover'
import { Tooltip } from './Tooltip'

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
  document.querySelectorAll('[role="tooltip"], [role="dialog"]').forEach((node) => node.remove())
  vi.useRealTimers()
})

function render(node: ReactNode): void {
  act(() => root.render(node))
}

describe('shared UI primitives', () => {
  it('keeps popup surfaces aligned with the Cate menu treatment', () => {
    expect(POPOVER_SURFACE).toContain('rounded-2xl')
    expect(POPOVER_SURFACE).toContain('border-subtle')
    expect(POPOVER_SURFACE).toContain('bg-surface-3')
    expect(POPOVER_SURFACE).toContain('shadow-lg')
  })

  it('shows an associated tooltip from keyboard focus and dismisses it with Escape', () => {
    vi.useFakeTimers()
    render(<Tooltip label="Refresh"><button type="button">Refresh</button></Tooltip>)
    const button = host.querySelector('button')!

    act(() => { button.focus(); vi.runAllTimers() })
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
    expect(tooltip?.textContent).toBe('Refresh')
    expect(button.getAttribute('aria-describedby')).toBe(tooltip?.id)

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('renders loading buttons as disabled and busy', () => {
    render(<Button loading loadingLabel="Saving…">Save</Button>)
    const button = host.querySelector('button')!
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.textContent).toContain('Saving…')
    expect(button.querySelector('.animate-spin')).not.toBeNull()
  })

  it('gives modals dialog semantics and associates their title', () => {
    render(<Modal title="Preferences" onClose={() => {}}><button type="button">Done</button></Modal>)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Preferences')
  })

  it('dismisses an open layer on outside pointer input and Escape', () => {
    function Layer() {
      const [open, setOpen] = useState(true)
      const contentRef = useRef<HTMLDivElement>(null)
      useDismissableLayer({ open, contentRef, onDismiss: () => setOpen(false) })
      return open ? <div ref={contentRef}>Menu</div> : <span>Closed</span>
    }
    render(<Layer />)
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(host.textContent).toBe('Closed')
  })
})

it('keeps tooltip bindings current and omits cleared shortcuts', async () => {
  const { useSettingsStore } = await import('../stores/settingsStore')
  const { storedShortcut } = await import('../../shared/types')
  vi.useFakeTimers()
  useSettingsStore.setState({ customShortcuts: {} })
  render(<Tooltip action="newTerminal" label="Terminal"><button>Terminal</button></Tooltip>)
  act(() => { host.querySelector('button')!.focus(); vi.runAllTimers() })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Terminal (⌘T)')
  act(() => useSettingsStore.setState({ customShortcuts: { newTerminal: storedShortcut('j', { command: true }) } }))
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Terminal (⌘J)')
  act(() => useSettingsStore.setState({ customShortcuts: { newTerminal: storedShortcut('') } }))
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Terminal')
  act(() => useSettingsStore.setState({ customShortcuts: {} }))
})

it.each(['left', 'right', 'top', 'bottom'] as const)('keeps a tooltip inside the %s window edge', (edge) => {
  vi.useFakeTimers()
  const width = 180, height = 28
  const x = edge === 'right' ? window.innerWidth - 24 : edge === 'left' ? 0 : 200
  const y = edge === 'bottom' ? window.innerHeight - 24 : edge === 'top' ? 0 : 200
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const tooltip = this.getAttribute('role') === 'tooltip'
    return { x, y, left: x, top: y, right: x + 24, bottom: y + 24,
      width: tooltip ? width : 24, height: tooltip ? height : 24, toJSON: () => ({}) }
  })
  try {
    // Top/bottom tooltips center over their anchor; left/right cases reproduce
    // clipping at either horizontal edge without changing preferred placement.
    const placement = edge === 'top' ? 'top' : 'bottom'
    render(<Tooltip label="Maximize split" placement={placement}><button>Maximize</button></Tooltip>)
    act(() => { host.querySelector('button')!.focus(); vi.runAllTimers() })
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8)
    expect(parseFloat(tooltip.style.left) + width).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(8)
    expect(parseFloat(tooltip.style.top) + height).toBeLessThanOrEqual(window.innerHeight - 8)
    expect(tooltip.style.visibility).toBe('visible')
    if (edge === 'top') expect(parseFloat(tooltip.style.top)).toBe(28)
    if (edge === 'bottom') expect(parseFloat(tooltip.style.top)).toBe(y - height - 4)
  } finally { measure.mockRestore() }
})

it('flips a side tooltip and repositions it when the window resizes', () => {
  vi.useFakeTimers()
  let anchorLeft = window.innerWidth - 24
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { left: anchorLeft, right: anchorLeft + 24, top: 100, bottom: 124,
      width: this.getAttribute('role') === 'tooltip' ? 180 : 24, height: 24 } as DOMRect
  })
  try {
    render(<Tooltip label="Expand toolbar" placement="right"><button>Expand</button></Tooltip>)
    act(() => { host.querySelector('button')!.focus(); vi.runAllTimers() })
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(parseFloat(tooltip.style.left)).toBe(anchorLeft - 186)
    anchorLeft = 0
    act(() => window.dispatchEvent(new Event('resize')))
    expect(parseFloat(tooltip.style.left)).toBe(30)
    expect(tooltip.style.maxWidth).toBe('calc(100vw - 16px)')
  } finally { measure.mockRestore() }
})
