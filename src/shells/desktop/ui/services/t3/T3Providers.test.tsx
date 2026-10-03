// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockClientUi } from '@kernel/interaction/testing'
import type { T3ProviderAuthSession } from '@services/t3/contract'
import { T3Providers, type T3ProvidersProxy } from './T3Providers'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LOOPBACK_SIGN_IN = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'
const DEVICE_SIGN_IN = 'https://auth.openai.com/codex/device'

let host: HTMLDivElement
let ui: ReturnType<typeof installMockClientUi>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  ui = installMockClientUi()
})
afterEach(() => host.remove())

function proxy(url: string): T3ProvidersProxy {
  const session: T3ProviderAuthSession = { id: 'a1', providerId: 'codex', phase: 'running', output: '', url }
  return {
    providerSettings: vi.fn(async () => ({ settings: { providers: {}, providerInstances: {} }, providers: [] })),
    providerStatuses: vi.fn(async () => []),
    providerAuthStart: vi.fn(async () => session),
    providerAuthGet: vi.fn(async () => session),
    providerAuthWrite: vi.fn(async () => undefined),
    providerAuthCancel: vi.fn(async () => undefined),
  } as unknown as T3ProvidersProxy
}

async function signIn(url: string, openInWorkspace?: (url: string) => boolean) {
  const root = createRoot(host)
  await act(async () => root.render(<T3Providers t3={proxy(url)} checkout="/repo" openInWorkspace={openInWorkspace} />))
  const button = [...host.querySelectorAll('button')].find((b) => /sign in/i.test(b.textContent ?? ''))
  expect(button).toBeDefined()
  await act(async () => button!.click())
  await act(async () => {})
  return root
}

describe('T3Providers sign-in page', () => {
  it('opens a sign-in that calls back to loopback in a workspace browser panel', async () => {
    const openInWorkspace = vi.fn(() => true)
    const root = await signIn(LOOPBACK_SIGN_IN, openInWorkspace)
    expect(openInWorkspace).toHaveBeenCalledWith(LOOPBACK_SIGN_IN)
    expect(ui.openExternal).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('opens other sign-in pages in the system browser', async () => {
    const openInWorkspace = vi.fn(() => true)
    const root = await signIn(DEVICE_SIGN_IN, openInWorkspace)
    expect(ui.openExternal).toHaveBeenCalledWith(DEVICE_SIGN_IN)
    expect(openInWorkspace).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })
})
