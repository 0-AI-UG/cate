import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPasswordManagerPage } from './BrowserPasswordManagerPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const browserCredentialRemove = vi.fn(async () => undefined)
let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    browserCredentialProfiles: vi.fn(async () => ({
      directImportSupported: false,
      secureStorageAvailable: true,
      profiles: [],
      importedCount: 1,
    })),
    browserCredentialList: vi.fn(async () => [{
      id: 'credential-1',
      origin: 'https://example.com',
      username: 'person@example.com',
    }]),
    browserCredentialRemove,
    browserCredentialImport: vi.fn(),
    browserCredentialImportFile: vi.fn(),
    browserCredentialClear: vi.fn(),
  }
  await act(async () => {
    root.render(<BrowserPasswordManagerPage />)
    await Promise.resolve()
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('BrowserPasswordManagerPage', () => {
  it('renders saved credential metadata without exposing passwords', () => {
    expect(host.textContent).toContain('Password manager')
    expect(host.textContent).toContain('example.com')
    expect(host.textContent).toContain('person@example.com')
    expect(host.textContent).not.toContain('correct horse battery staple')
  })

  it('deletes an individual saved credential', async () => {
    const removeButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove password for https://example.com"]',
    )
    await act(async () => {
      removeButton?.click()
      await Promise.resolve()
    })

    expect(browserCredentialRemove).toHaveBeenCalledWith('credential-1')
    expect(host.textContent).not.toContain('person@example.com')
  })
})
