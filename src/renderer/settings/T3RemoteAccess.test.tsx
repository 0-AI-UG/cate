import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { T3RemoteAccess } from './T3RemoteAccess'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const url = `https://app.t3.codes/connect#state=${'a'.repeat(22)}&challenge=${'b'.repeat(43)}&port=34338`
const start = vi.fn()
const get = vi.fn()
const write = vi.fn().mockResolvedValue({ ok: true })

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  start.mockReset(); get.mockReset(); write.mockClear()
  start.mockResolvedValueOnce({ id: 'status', operation: 'status', phase: 'succeeded', output: '{"desired":false,"authenticated":false,"linked":false}' })
  Object.assign(window.electronAPI, {
    agentRemoteStart: start,
    agentRemoteGet: get,
    agentRemoteWrite: write,
    agentRemoteCancel: vi.fn().mockResolvedValue({ ok: true }),
    terminalClipboardWrite: vi.fn().mockResolvedValue(undefined),
  })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it('keeps the connect flow inline and asks the CLI to open its loopback link', async () => {
  await act(async () => root.render(<T3RemoteAccess workspaceId="ws" cwd="/repo" />))
  expect(host.textContent).toContain('Off')
  expect(host.textContent).not.toContain('"desired"')

  start.mockResolvedValueOnce({ id: 'link', operation: 'link', phase: 'running', output: 'Preparing' })
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Enable')!.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  get.mockResolvedValue({ id: 'link', operation: 'link', phase: 'running', output: `Open this URL: ${url}\n`, authorizationUrl: url })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)) })
  expect(host.textContent).toContain('Authorize T3 Connect')
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Open sign-in page'))!.click())
  expect(write).toHaveBeenCalledWith({ id: 'link', data: '\r' })
  expect(host.textContent).toContain('Waiting for browser sign-in')
  expect(host.querySelector('details')).not.toBeNull()
})

it('explains how to find a linked environment on the phone', async () => {
  start.mockReset()
  start.mockResolvedValue({ id: 'status', operation: 'status', phase: 'succeeded', output: '{"desired":true,"authenticated":true,"linked":true}' })
  await act(async () => root.render(<T3RemoteAccess workspaceId="ws" cwd="/repo" />))
  expect(host.textContent).toContain('Connect your phone')
  expect(host.textContent).toContain('same T3 Connect account')
  expect(host.textContent).toContain('direct network pairing')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
