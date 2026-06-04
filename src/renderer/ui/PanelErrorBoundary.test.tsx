// =============================================================================
// Tests for PanelErrorBoundary — a render error in one panel must fail in place
// (show the inline fallback) rather than propagate, must report to Sentry, and
// must reset both on the "Reload panel" action and when the slot's panelId
// changes.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const captureRendererException = vi.fn()
vi.mock('../lib/sentry', () => ({
  captureRendererException: (...args: unknown[]) => captureRendererException(...args),
}))

import { PanelErrorBoundary } from './PanelErrorBoundary'

let host: HTMLDivElement
let root: Root

function Boom({ explode }: { explode: boolean }): React.ReactElement {
  if (explode) throw new Error('kaboom')
  return <div className="ok">alive</div>
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  captureRendererException.mockClear()
  // React logs caught render errors to console.error; silence the noise.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('PanelErrorBoundary', () => {
  it('renders children when there is no error', () => {
    act(() => {
      root.render(
        <PanelErrorBoundary panelType="terminal" panelId="p1">
          <Boom explode={false} />
        </PanelErrorBoundary>,
      )
    })
    expect(host.querySelector('.ok')?.textContent).toBe('alive')
  })

  it('catches a render error, shows the fallback, and reports to Sentry', () => {
    act(() => {
      root.render(
        <PanelErrorBoundary panelType="browser" panelId="p1">
          <Boom explode={true} />
        </PanelErrorBoundary>,
      )
    })
    expect(host.textContent).toContain('This browser panel hit an error')
    expect(host.textContent).toContain('kaboom')
    expect(host.querySelector('.ok')).toBeNull()
    expect(captureRendererException).toHaveBeenCalledTimes(1)
    const [, ctx] = captureRendererException.mock.calls[0]
    expect(ctx).toMatchObject({ panelType: 'browser', panelId: 'p1', source: 'PanelErrorBoundary' })
  })

  it('does not propagate the error to a parent boundary (isolation)', () => {
    let parentCaught = false
    class Parent extends React.Component<{ children?: React.ReactNode }, { err: boolean }> {
      state = { err: false }
      static getDerivedStateFromError() {
        parentCaught = true
        return { err: true }
      }
      render() {
        return this.state.err ? <div>parent-fallback</div> : this.props.children
      }
    }
    act(() => {
      root.render(
        <Parent>
          <PanelErrorBoundary panelType="editor" panelId="p1">
            <Boom explode={true} />
          </PanelErrorBoundary>
        </Parent>,
      )
    })
    expect(parentCaught).toBe(false)
    expect(host.textContent).toContain('This editor panel hit an error')
    expect(host.textContent).not.toContain('parent-fallback')
  })

  it('resets when panelId changes (slot reused for a different panel)', () => {
    act(() => {
      root.render(
        <PanelErrorBoundary panelType="terminal" panelId="p1">
          <Boom explode={true} />
        </PanelErrorBoundary>,
      )
    })
    expect(host.textContent).toContain('hit an error')

    // Slot reused for panel p2 with a healthy child → fallback clears.
    act(() => {
      root.render(
        <PanelErrorBoundary panelType="terminal" panelId="p2">
          <Boom explode={false} />
        </PanelErrorBoundary>,
      )
    })
    expect(host.querySelector('.ok')?.textContent).toBe('alive')
  })

  it('"Reload panel" clears the fallback and re-mounts a now-healthy child', () => {
    function Toggler(): React.ReactElement {
      // First render throws; the boundary's reload re-renders the subtree, and
      // by then the module-level flag has flipped to healthy.
      return <Boom explode={shouldExplode} />
    }
    let shouldExplode = true
    act(() => {
      root.render(
        <PanelErrorBoundary panelType="terminal" panelId="p1">
          <Toggler />
        </PanelErrorBoundary>,
      )
    })
    expect(host.textContent).toContain('hit an error')

    shouldExplode = false
    const button = host.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toContain('Reload panel')
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(host.querySelector('.ok')?.textContent).toBe('alive')
  })
})
