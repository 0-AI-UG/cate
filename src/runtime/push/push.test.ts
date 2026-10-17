import { describe, expect, it } from 'vitest'
import type { ConnectPush, ConnectPushResult } from '@runtime/connect/contract'
import { encodeBase64, sealPushMessage, type PushMessage } from './contract'
import { openPushMessage } from '../../test/push'
import { createPushService, type PushFile, type PushSender } from './runtime'

const key = new Uint8Array(32).fill(7)
const target = `apns:sandbox:${'ab'.repeat(32)}`

function setup(options: { sender?: PushSender | null; result?: ConnectPushResult } = {}) {
  let file: PushFile = { targets: [] }
  const sent: ConnectPush[] = []
  const sender: PushSender = {
    pushAvailable: () => true,
    push: async (push) => { sent.push(push); return options.result ?? 'sent' },
  }
  const service = createPushService({
    runtimeId: 'aaaaaaaaaaaaaaaa',
    workspace: 'cate',
    store: { get: () => file, update: (fn) => { file = fn(file) } },
    sender: () => (options.sender === undefined ? sender : options.sender),
    now: () => 5,
  })
  return { service, sent, file: () => file }
}

describe('push', () => {
  it('seals a message only the device key opens', () => {
    const message: PushMessage = { runtimeId: 'r', workspace: 'w', kind: 'k', panelId: null, title: 't', body: 'b' }
    const sealed = sealPushMessage(key, message)
    expect(openPushMessage(key, sealed)).toEqual(message)
    expect(openPushMessage(new Uint8Array(32), sealed)).toBeNull()
    expect(sealed).not.toContain('"title"')
  })

  it('registers one target per device and seals each event, unchanged, for it', async () => {
    const { service, sent, file } = setup()
    expect(service.register('phone', { target, key: encodeBase64(key) })).toEqual({ registered: true, blocked: null })
    service.register('phone', { target: `apns:production:${'cd'.repeat(32)}`, key: encodeBase64(key) })
    expect(file().targets).toHaveLength(1)

    await service.notify({ kind: 'agent.needsInput', panelId: 'claude', title: 'Claude Code needs input', body: 'Claude Code is waiting for your response.' })
    await service.notify({ kind: 'cate.ui.notify', title: 'Build done', body: 'All green' })
    expect(sent.map((push) => [push.target, push.collapseId])).toEqual([
      [`apns:production:${'cd'.repeat(32)}`, 'aaaaaaaaaaaaaaaa.claude'],
      [`apns:production:${'cd'.repeat(32)}`, 'aaaaaaaaaaaaaaaa.notice.5'],
    ])
    expect(openPushMessage(key, sent[0].sealed)).toEqual({
      runtimeId: 'aaaaaaaaaaaaaaaa', workspace: 'cate', kind: 'agent.needsInput', panelId: 'claude',
      title: 'Claude Code needs input', body: 'Claude Code is waiting for your response.',
    })
  })

  it('drops a target the service no longer delivers to, and a device that was unpaired', async () => {
    const gone = setup({ result: 'bad-target' })
    gone.service.register('phone', { target, key: encodeBase64(key) })
    await gone.service.notify({ kind: 'cate.ui.notify', title: 't', body: 'b' })
    expect(gone.file().targets).toEqual([])

    const { service, file } = setup()
    service.register('phone', { target, key: encodeBase64(key) })
    service.forgetDevice('phone')
    expect(file().targets).toEqual([])
  })

  it('says why pushes cannot go out, and refuses a malformed registration', () => {
    expect(setup({ sender: null }).service.status('phone')).toEqual({ registered: false, blocked: 'cateConnectOff' })
    const unavailable = setup({ sender: { pushAvailable: () => false, push: async () => 'unavailable' } })
    expect(unavailable.service.status('phone')).toEqual({ registered: false, blocked: 'serviceUnavailable' })
    const { service } = setup()
    expect(() => service.register('phone', { target: 'no target', key: encodeBase64(key) })).toThrow()
    expect(() => service.register('phone', { target, key: encodeBase64(new Uint8Array(8)) })).toThrow()
  })
})
