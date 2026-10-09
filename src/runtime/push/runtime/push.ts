// Pushes to paired devices (the `push` capability): each notification event
// is sealed for every registered device and handed to Cate Connect, which
// forwards it to APNs. Nothing is queued: with no way out, a push is dropped,
// and the device sees the agent's state when it next connects.

import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl, CallContext } from '@kernel/rpc/runtime'
import type { Logger } from '@kernel/log/contract'
import type { ConnectPush, ConnectPushResult } from '@runtime/connect/contract'
import { isDeviceKey } from '@runtime/pairing/contract'
import { fingerprint, hexToBytes } from '@runtime/security/contract'
import {
  decodeBase64,
  isPushTarget,
  PUSH_KEY_BYTES,
  pushCollapseId,
  sealPushMessage,
  type PushStatus,
  type pushCapability,
} from '../contract'
import type { PushStore } from './pushFile'

/** What pushes go out through: the Cate Connect registration. */
export interface PushSender {
  pushAvailable(): boolean
  push(push: ConnectPush): Promise<ConnectPushResult>
}

/** A notification event (architecture 10.5) as pushes carry it. */
export interface PushEvent {
  kind: string
  panelId?: string
  title: string
  body: string
}

export interface PushDeps {
  /** The runtime's network id, which paired devices know it by. */
  runtimeId: string
  /** The workspace folder's name, shown with each notification. */
  workspace: string
  store: PushStore
  /** The registration while network access is Cate Connect, else null. */
  sender(): PushSender | null
  log?: Logger
  now?: () => number
}

export interface PushService {
  status(device: string): PushStatus
  register(device: string, params: { target: string; key: string }): PushStatus
  unregister(device: string): PushStatus
  /** A device was unpaired. */
  forgetDevice(device: string): void
  notify(event: PushEvent): Promise<void>
}

const TITLE_MAX = 200
const BODY_MAX = 1_000

export function createPushService(deps: PushDeps): PushService {
  const now = deps.now ?? Date.now

  const status = (device: string): PushStatus => {
    const sender = deps.sender()
    return {
      registered: deps.store.get().targets.some((target) => target.device === device),
      blocked: !sender ? 'cateConnectOff' : sender.pushAvailable() ? null : 'serviceUnavailable',
    }
  }

  const drop = (device: string, target?: string) => {
    deps.store.update((file) => ({
      targets: file.targets.filter((entry) => entry.device !== device || (target !== undefined && entry.target !== target)),
    }))
  }

  return {
    status,
    register(device, { target, key }) {
      if (!isPushTarget(target)) throw new RpcError('rejected', 'Expected a push target')
      let keyBytes: Uint8Array
      try {
        keyBytes = decodeBase64(key)
      } catch {
        throw new RpcError('rejected', 'Expected a base64 key')
      }
      if (keyBytes.length !== PUSH_KEY_BYTES) throw new RpcError('rejected', `Expected a ${PUSH_KEY_BYTES}-byte key`)
      deps.store.update((file) => ({
        targets: [
          ...file.targets.filter((entry) => entry.device !== device && entry.target !== target),
          { device, target, key, registeredAt: now() },
        ],
      }))
      return status(device)
    },
    unregister(device) {
      drop(device)
      return status(device)
    },
    forgetDevice: (device) => drop(device),
    async notify(event) {
      const targets = deps.store.get().targets
      const sender = deps.sender()
      if (targets.length === 0 || !sender?.pushAvailable()) return
      const message = {
        runtimeId: deps.runtimeId,
        workspace: deps.workspace,
        kind: event.kind,
        panelId: event.panelId ?? null,
        title: event.title.slice(0, TITLE_MAX),
        body: event.body.slice(0, BODY_MAX),
      }
      const collapseId = pushCollapseId(deps.runtimeId, event.panelId, now())
      await Promise.all(targets.map(async (entry) => {
        const result = await sender.push({
          target: entry.target,
          sealed: sealPushMessage(decodeBase64(entry.key), message),
          collapseId,
        })
        if (result === 'bad-target') drop(entry.device, entry.target)
        else if (result !== 'sent') deps.log?.info('push to %s: %s', entry.device, result)
      }))
    },
  }
}

function deviceOf(ctx: CallContext): string {
  const key = ctx.connection.client?.device.publicKey
  if (!isDeviceKey(key)) throw new RpcError('rejected', 'Only a device registers for pushes')
  return fingerprint(hexToBytes(key))
}

export function pushCapabilityImpl(service: PushService): CapabilityImpl<typeof pushCapability> {
  return {
    register: (params, ctx) => service.register(deviceOf(ctx), params),
    unregister: (_params, ctx) => service.unregister(deviceOf(ctx)),
    status: (_params, ctx) => service.status(deviceOf(ctx)),
  }
}

