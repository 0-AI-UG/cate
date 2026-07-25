import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserStore } from '../stores/browserStore'
import { useUIStore } from '../stores/uiStore'
import { BrowserMenu } from './BrowserMenu'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialUIState = useUIStore.getState()
const initialBrowserState = useBrowserStore.getState()
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useUIStore.setState({ showSettings: false, settingsInitialTab: null })
  useBrowserStore.setState({ bookmarks: [] })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useUIStore.setState(initialUIState, true)
  useBrowserStore.setState(initialBrowserState, true)
})

describe('BrowserMenu', () => {
  it('opens Cate settings at the Browser section', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(
        <BrowserMenu
          onNewTab={vi.fn()}
          onNavigate={vi.fn()}
          onOpenPasswordManager={vi.fn()}
          onClose={onClose}
          triggerRef={{ current: null }}
        />,
      )
    })

    const settingsButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Browser settings'))
    act(() => settingsButton?.click())

    expect(onClose).toHaveBeenCalledOnce()
    expect(useUIStore.getState()).toMatchObject({
      showSettings: true,
      settingsInitialTab: 'browser',
    })
  })

  it('does not keep browser preferences in the panel menu', () => {
    act(() => {
      root.render(
        <BrowserMenu
          onNewTab={vi.fn()}
          onNavigate={vi.fn()}
          onOpenPasswordManager={vi.fn()}
          onClose={vi.fn()}
          triggerRef={{ current: null }}
        />,
      )
    })

    expect(host.textContent).not.toContain('Show bookmarks')
  })

  it('opens password management inside the browser', () => {
    const onOpenPasswordManager = vi.fn()
    act(() => {
      root.render(
        <BrowserMenu
          onNewTab={vi.fn()}
          onNavigate={vi.fn()}
          onOpenPasswordManager={onOpenPasswordManager}
          onClose={vi.fn()}
          triggerRef={{ current: null }}
        />,
      )
    })

    const passwordButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Passwords and autofill'))
    act(() => passwordButton?.click())

    expect(onOpenPasswordManager).toHaveBeenCalledOnce()
  })

  it('opens bookmarks on hover and navigates from the submenu', () => {
    const onNavigate = vi.fn()
    const onClose = vi.fn()
    useBrowserStore.setState({
      bookmarks: [{
        url: 'https://example.com/docs',
        title: 'Example docs',
        addedAt: 1,
      }],
    })
    act(() => {
      root.render(
        <BrowserMenu
          onNewTab={vi.fn()}
          onNavigate={onNavigate}
          onOpenPasswordManager={vi.fn()}
          onClose={onClose}
          triggerRef={{ current: null }}
        />,
      )
    })

    const bookmarksButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Bookmarks'))
    act(() => {
      bookmarksButton?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })

    const bookmark = host.querySelector('[role="menuitem"]') as HTMLButtonElement
    expect(bookmark.textContent).toContain('Example docs')
    act(() => bookmark.click())
    expect(onNavigate).toHaveBeenCalledWith('https://example.com/docs')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not reopen when its trigger is clicked while the menu is open', () => {
    function Harness(): JSX.Element {
      const [open, setOpen] = useState(false)
      const triggerRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={triggerRef} onClick={() => setOpen((value) => !value)}>
            Menu trigger
          </button>
          {open && (
            <BrowserMenu
              onNewTab={vi.fn()}
              onNavigate={vi.fn()}
              onOpenPasswordManager={vi.fn()}
              onClose={() => setOpen(false)}
              triggerRef={triggerRef}
            />
          )}
        </>
      )
    }

    act(() => root.render(<Harness />))
    const trigger = host.querySelector('button') as HTMLButtonElement
    act(() => trigger.click())
    expect(host.textContent).toContain('New tab')

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      trigger.click()
    })
    expect(host.textContent).not.toContain('New tab')
  })
})
