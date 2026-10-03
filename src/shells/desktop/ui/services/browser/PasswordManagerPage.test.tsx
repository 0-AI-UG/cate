import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { installBrowserPageBridge } from '@services/browser/client'
import { BrowserPasswordManagerPage } from './PasswordManagerPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const removePassword = vi.fn(async () => undefined)
const savePassword = vi.fn(async () => ({
  action: 'created' as const,
  credential: { id: 'credential-2', origin: 'https://new.example', username: 'new@example.com' },
}))
let host: HTMLDivElement
let root: Root
let restore: () => void

beforeEach(async () => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const runtime = {
    browserData: {
      passwords: vi.fn(async () => [{ id: 'credential-1', origin: 'https://example.com', username: 'person@example.com' }]),
      removePassword,
      savePassword,
      importPasswords: vi.fn(),
      clearPasswords: vi.fn(),
    },
  } as unknown as RuntimeProxy
  restore = setRuntimeResolver((id) => (id === 'ws' ? runtime : null))
  installBrowserPageBridge({ chromeProfiles: vi.fn(async () => ({ directImportSupported: false, profiles: [] })) } as never)
  await act(async () => {
    root.render(<BrowserPasswordManagerPage workspaceId="ws" />)
    await Promise.resolve()
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  restore()
  installBrowserPageBridge(null)
})

describe('BrowserPasswordManagerPage', () => {
  it('fills the browser content surface instead of shrink-wrapping to its contents', () => {
    const page = host.querySelector('[data-browser-password-manager]')
    expect(page).not.toBeNull()
    expect(page?.classList).toContain('absolute')
    expect(page?.classList).toContain('inset-0')
    expect(page?.classList).toContain('w-full')
    expect(page?.classList).toContain('h-full')
  })

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

    expect(removePassword).toHaveBeenCalledWith({ id: 'credential-1' })
    expect(host.textContent).not.toContain('person@example.com')
  })

  it('adds a password explicitly from the trusted manager UI', async () => {
    const addButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Add password'))
    act(() => addButton?.click())
    const inputs = host.querySelectorAll<HTMLInputElement>('form input')
    const values = ['https://new.example/login', 'new@example.com', 'new secret']
    await act(async () => {
      inputs.forEach((input, index) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, values[index])
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await Promise.resolve()
    })

    const saveButton = [...host.querySelectorAll<HTMLButtonElement>('form button')]
      .find((button) => button.textContent?.includes('Save'))
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
    })

    expect(savePassword).toHaveBeenCalledWith({
      input: { origin: 'https://new.example/login', username: 'new@example.com', password: 'new secret' },
    })
    expect(host.textContent).toContain('Password saved.')
  })
})
