import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { BrowserSettings } from './BrowserSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialSettingsState = useSettingsStore.getState()
const browserClearData = vi.fn(async () => undefined)
const settingsSet = vi.fn(async () => undefined)
let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useSettingsStore.setState({
    browserHomepage: 'https://example.com',
    browserSearchEngine: 'google',
    browserProxyUrl: '',
    browserNewTabBehavior: 'startPage',
    browserShowTabSidebar: false,
    terminalLinkOpenTarget: 'ask',
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    browserClearData,
    settingsSet,
    browserCredentialProfiles: vi.fn(async () => ({
      directImportSupported: false,
      secureStorageAvailable: true,
      profiles: [],
      importedCount: 0,
    })),
    browserCredentialImport: vi.fn(),
    browserCredentialImportFile: vi.fn(),
    browserCredentialClear: vi.fn(),
  }
  await act(async () => {
    root.render(<BrowserSettings />)
    await Promise.resolve()
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettingsStore.setState(initialSettingsState, true)
})

describe('BrowserSettings', () => {
  it('contains the settings formerly shown in the browser popover', () => {
    expect(host.textContent).toContain('New tab opens')
    expect(host.textContent).toContain('Proxy')
    expect(host.textContent).not.toContain('Show bookmarks sidebar')
    expect(host.textContent).toContain('Clear browsing data')
    expect(host.textContent).not.toContain('Chrome passwords')
    expect(host.textContent).not.toContain('macOS')
  })

  it('commits a trimmed global proxy when editing finishes', () => {
    const proxyInput = host.querySelector(
      'input[placeholder="http://proxy.company.com:8080"]',
    ) as HTMLInputElement

    act(() => {
      proxyInput.focus()
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(proxyInput, ' http://proxy.example:8080 ')
      proxyInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => proxyInput.blur())

    expect(useSettingsStore.getState().browserProxyUrl).toBe('http://proxy.example:8080')
    expect(settingsSet).toHaveBeenCalledWith('browserProxyUrl', 'http://proxy.example:8080')
  })

  it('requires confirmation before clearing shared browsing data', async () => {
    const clearButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Clear…'))

    act(() => clearButton?.click())
    expect(browserClearData).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Confirm clear')

    const confirmButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Confirm clear'))
    await act(async () => {
      confirmButton?.click()
      await Promise.resolve()
    })

    expect(browserClearData).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('Browsing data cleared.')
  })
})
