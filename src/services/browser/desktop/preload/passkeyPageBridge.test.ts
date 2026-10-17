// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installPasskeyPageBridge } from './passkeyPageBridge'

const request = vi.fn()
const cancel = vi.fn()
const originalGet = vi.fn()
const originalCreate = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('PublicKeyCredential', class {})
  vi.stubGlobal('AuthenticatorAttestationResponse', class {})
  vi.stubGlobal('AuthenticatorAssertionResponse', class {})
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: originalGet, create: originalCreate } })
  ;(window as any).__catePasskeys = { request, cancel }
  installPasskeyPageBridge()
})
afterEach(() => { vi.unstubAllGlobals(); delete (window as any).__catePasskeys })

it('preserves non-public-key credential requests', async () => {
  await navigator.credentials.get()
  expect(originalGet).toHaveBeenCalledOnce()
  expect(request).not.toHaveBeenCalled()
})
it('serializes sliced buffers and reconstructs an assertion response', async () => {
  request.mockResolvedValue({ id: 'AQ', rawId: 'AQ', authenticatorAttachment: 'platform', response: {
    clientDataJSON: 'e30', authenticatorData: 'Ag', signature: 'Aw', userHandle: null,
  } })
  const bytes = new Uint8Array([0, 1, 2, 3])
  const result = await navigator.credentials.get({ publicKey: { challenge: bytes.subarray(1, 3) } }) as PublicKeyCredential
  expect(request.mock.calls[0][0].options.challenge).toBe('AQI')
  expect(result).toBeInstanceOf(PublicKeyCredential)
  expect(new Uint8Array(result.rawId)).toEqual(new Uint8Array([1]))
  expect((result.response as AuthenticatorAssertionResponse).userHandle).toBeNull()
  expect(result.toJSON()).toMatchObject({ rawId: 'AQ', response: { signature: 'Aw' } })
})
it('cancels the native operation when the site aborts', async () => {
  request.mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const pending = navigator.credentials.get({ publicKey: { challenge: new Uint8Array([1]) }, signal: controller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(cancel).toHaveBeenCalledWith(request.mock.calls[0][0].id)
})
it('preserves a nearby-device assertion and hybrid credential hints', async () => {
  request.mockResolvedValue({ id: 'AQ', rawId: 'AQ', authenticatorAttachment: 'cross-platform', response: {
    clientDataJSON: 'e30', authenticatorData: 'Ag', signature: 'Aw', userHandle: 'BA',
  } })
  const result = await navigator.credentials.get({ publicKey: {
    challenge: new Uint8Array([1]),
    allowCredentials: [{ type: 'public-key', id: new Uint8Array([1]), transports: ['hybrid'] }],
  } }) as PublicKeyCredential
  expect(request.mock.calls[0][0].options.allowCredentials).toEqual([{ type: 'public-key', id: 'AQ', transports: ['hybrid'] }])
  expect(result.authenticatorAttachment).toBe('cross-platform')
  expect(result.toJSON()).toMatchObject({ authenticatorAttachment: 'cross-platform', response: { signature: 'Aw', userHandle: 'BA' } })
})
it('does not advertise or open a modal for conditional mediation', async () => {
  expect(await PublicKeyCredential.isConditionalMediationAvailable()).toBe(false)
  await expect(navigator.credentials.get({ publicKey: { challenge: new Uint8Array([1]) }, mediation: 'conditional' }))
    .rejects.toMatchObject({ name: 'NotSupportedError' })
  expect(request).not.toHaveBeenCalled()
})
