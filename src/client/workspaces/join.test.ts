import { describe, expect, it } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { bytesEqual, createMemoryPortPair, fingerprint, generateKeyPair, networkIdOf } from '@runtime/security/contract'
import { acceptPeer } from '@runtime/security/runtime'
import { PairingService, type PairingsFile, type PairingsStore } from '@runtime/pairing/runtime'
import { pairWithRuntime } from '@runtime/pairing/client'
import type { PairedRuntime, WorkspaceConnections } from '@client/connections'
import { joinErrorMessage, joinWorkspace, parsePairingInput } from './join'
import { WorkspaceList } from './workspaceList'

const RUNTIME_KEYS = generateKeyPair()
const RUNTIME_ID = networkIdOf(RUNTIME_KEYS.publicKey)

function memoryStore(): PairingsStore {
  let value: PairingsFile = { devices: [] }
  return { get: () => value, update: (fn) => { value = fn(value) }, subscribe: () => () => {} }
}

function setup() {
  const runtimeKeys = RUNTIME_KEYS
  const service = new PairingService({
    runtimePublicKey: runtimeKeys.publicKey,
    store: memoryStore(),
    addresses: () => ['192.168.1.4:4100'],
  })
  const connections = { subscribe: () => () => {}, getSnapshot: () => [] } as unknown as WorkspaceConnections
  const workspaces = new WorkspaceList({ store: createMemoryDeviceStore(), connections })
  const deviceKeys = generateKeyPair()
  const dialed: string[] = []
  // A shell without a privileged process pairs in place over a raw port.
  const pairAs = (deviceKeys: ReturnType<typeof generateKeyPair>) => async (link: string): Promise<PairedRuntime> => {
    dialed.push(link)
    const target = parsePairingInput(link)
    const [a, b] = createMemoryPortPair()
    void acceptPeer(b, { runtimeKeys, policy: service }).catch(() => {})
    const channel = await pairWithRuntime(a, {
      deviceKeys,
      deviceName: 'Test phone',
      target: { runtimeId: target.runtimeId, secret: target.secret, fingerprint: target.fingerprint },
      pins: workspaces.known,
    })
    channel.close()
    return { runtimeId: target.runtimeId, endpoints: target.endpoints, publicKey: channel.remoteStatic }
  }
  return { runtimeKeys, service, workspaces, pair: pairAs(deviceKeys), pairAs, deviceKeys, dialed }
}

describe('parsePairingInput', () => {
  it('reads a scanned link with its fingerprint and LAN endpoints', () => {
    const { service } = setup()
    const { uri } = service.createSecret('sameNetwork')
    const target = parsePairingInput(uri)
    expect(target.runtimeId).toBe(RUNTIME_ID)
    expect(target.fingerprint).toBeTruthy()
    expect(target.endpoints).toEqual([{ kind: 'lan', address: '192.168.1.4', port: 4100 }])
  })

  it('reads a typed code in any case and spacing, without endpoints', () => {
    const { service } = setup()
    const { code } = service.createSecret('cateConnect')
    const target = parsePairingInput(`  ${code.toUpperCase().replace(/-/g, ' ')} `)
    expect(target.runtimeId).toBe(RUNTIME_ID)
    expect(target.fingerprint).toBeUndefined()
    expect(target.endpoints).toEqual([])
  })

  it('refuses garbage with a readable message', () => {
    let error: unknown
    try { parsePairingInput('hello') } catch (err) { error = err }
    expect(joinErrorMessage(error)).toBe('That is not a Cate pairing code.')
  })
})

describe('joinWorkspace', () => {
  it('pairs, pins the runtime key and adds the workspace', async () => {
    const ctx = setup()
    const { uri } = ctx.service.createSecret('sameNetwork')
    const entry = await joinWorkspace(` ${uri} `, { pair: ctx.pair, workspaces: ctx.workspaces })
    expect(entry.id).toBe(`paired:${RUNTIME_ID}`)
    expect(entry.endpoints).toEqual([{ kind: 'lan', address: '192.168.1.4', port: 4100 }])
    expect(ctx.dialed).toEqual([uri])
    const pinned = await ctx.workspaces.known.get(RUNTIME_ID)
    expect(pinned && bytesEqual(pinned, ctx.runtimeKeys.publicKey)).toBe(true)
    expect(ctx.service.list().map((d) => d.fingerprint)).toEqual([fingerprint(ctx.deviceKeys.publicKey)])
  })

  it('fails on a used code and says so', async () => {
    const ctx = setup()
    const { code } = ctx.service.createSecret('sameNetwork')
    await joinWorkspace(code, { pair: ctx.pair, workspaces: ctx.workspaces })
    let error: unknown
    try {
      await joinWorkspace(code, { pair: ctx.pairAs(generateKeyPair()), workspaces: ctx.workspaces })
    } catch (err) { error = err }
    expect(joinErrorMessage(error)).toMatch(/refused/)
  })

  it('refuses an answer from another runtime', async () => {
    const ctx = setup()
    const { code } = ctx.service.createSecret('sameNetwork')
    const other = async () => ({ runtimeId: 'qrstuvwxyzabcdef', endpoints: [], publicKey: ctx.runtimeKeys.publicKey })
    let error: unknown
    try { await joinWorkspace(code, { pair: other, workspaces: ctx.workspaces }) } catch (err) { error = err }
    expect(joinErrorMessage(error)).toMatch(/not the one in the code/)
  })
})
