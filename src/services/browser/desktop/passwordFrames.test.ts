import { expect, it, vi } from 'vitest'
import { PasswordFrames } from './passwordFrames'

function setup() {
  const send = vi.fn(async (method: string) => method === 'Runtime.evaluate'
    ? { result: { objectId: 'field' } }
    : method === 'DOM.describeNode' ? { node: { backendNodeId: 12 } } : {})
  const emit = vi.fn()
  const frames = new PasswordFrames({ send, emit, offset: async () => ({ x: 40, y: 80 }), automated: () => false })
  const context = (id = 7, name = 'cate-passwords') => frames.handle('Runtime.executionContextCreated', {
    context: { id, name, auxData: { frameId: 'apple-login' } },
  }, 'apple-session')
  const message = (channel: string, payload: unknown, id = 7) => frames.handle('Runtime.bindingCalled', {
    name: '__catePasswordEvent', executionContextId: id, payload: JSON.stringify({ channel, payload }),
  }, 'apple-session')
  return { send, emit, frames, context, message }
}

it('installs isolated-world detection in existing and future cross-origin frames', async () => {
  const { send, frames } = setup()
  await frames.install('apple-session')
  expect(send).toHaveBeenCalledWith('Runtime.addBinding', { name: '__catePasswordEvent', executionContextName: 'cate-passwords' }, 'apple-session')
  expect(send).toHaveBeenCalledWith('Page.addScriptToEvaluateOnNewDocument', expect.objectContaining({ worldName: 'cate-passwords', runImmediately: true }), 'apple-session')
})

it('offers and fills the login frame origin, translates its popup, and rejects stale or mismatched fills', async () => {
  const { send, emit, frames, context, message } = setup()
  context()
  message('cate-browser-password-focus', { targetId: 'field-id', origin: 'https://idmsa.apple.com', rect: { left: 10, bottom: 30, width: 100, height: 20 } })
  await vi.waitFor(() => expect(emit).toHaveBeenLastCalledWith('focus', expect.objectContaining({ origin: 'https://idmsa.apple.com', rect: { left: 50, bottom: 110, width: 100, height: 20 } })))
  await expect(frames.resolve('field-id', 'https://appstoreconnect.apple.com')).rejects.toThrow('credential-target-expired')
  await expect(frames.resolve('field-id', 'https://idmsa.apple.com')).resolves.toMatchObject({ objectId: 'field', frameId: 'apple-login', sessionId: 'apple-session' })
  expect(send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ contextId: 7, expression: expect.stringContaining('location.origin === "https://idmsa.apple.com"') }), 'apple-session')
  frames.handle('Runtime.executionContextDestroyed', { executionContextId: 7 }, 'apple-session')
  await expect(frames.resolve('field-id', 'https://idmsa.apple.com')).rejects.toThrow('credential-target-expired')
})

it('captures a manual iframe submission and ignores events from page-authored worlds', () => {
  const { emit, context, message } = setup()
  const payload = { origin: 'https://idmsa.apple.com', username: 'person', password: 'synthetic-secret' }
  context(8, '')
  message('cate-browser-password-submit', payload, 8)
  expect(emit).not.toHaveBeenCalled()
  context()
  message('cate-browser-password-submit', payload)
  expect(emit).toHaveBeenCalledWith('submit', { ...payload, automated: false })
})
