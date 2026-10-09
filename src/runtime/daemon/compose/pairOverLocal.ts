// `cate serve` on a workspace: trust it, turn network access on and print a
// pairing QR code and code (one JSON line with `--json`).

import QRCode from 'qrcode'
import { framePortOver } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { settingsCapability } from '@kernel/settings/contract'
import { pairingCapability, PAIRING_SECRET_TTL_MS, type CreatedSecret, type PairingMode } from '@runtime/pairing/contract'
import { dialLocal } from '@runtime/transports/node'
import { workspaceCapability } from '@workspace/lifecycle/contract'
import { RUNTIME_VERSION } from '../contract'

/** Asks a running daemon, as a local client, to trust the workspace (as
 *  `cate serve` does when it starts one), turn network on and for a pairing
 *  secret. */
export async function pairOverLocal(endpoint: string, mode: PairingMode, root: string, json?: boolean): Promise<void> {
  const client = new RpcClient({
    version: RUNTIME_VERSION,
    identity: { client: { clientId: `serve-${process.pid}`, device: { name: 'cate serve', keyFingerprint: '' }, features: [] } },
  })
  try {
    await client.attach(framePortOver(await dialLocal(endpoint), 'stream'))
    await createCapabilityProxy(client, workspaceCapability).setTrust({ trusted: true })
    await createCapabilityProxy(client, settingsCapability).set({ key: 'runtimeNetwork', value: mode })
    await printPairing(root, await createCapabilityProxy(client, pairingCapability).createSecret({ mode }), json)
  } finally {
    client.close()
  }
}

export async function printPairing(root: string, created: CreatedSecret, json?: boolean): Promise<void> {
  if (json) {
    process.stdout.write(`${JSON.stringify({ root, uri: created.uri, code: created.code, expiresAt: created.expiresAt })}\n`)
    return
  }
  const qr = await QRCode.toString(created.uri, { type: 'terminal', small: true })
  const minutes = Math.round(PAIRING_SECRET_TTL_MS / 60_000)
  process.stdout.write([
    `Serving ${root}`,
    'Scan this code in Cate to pair a device:',
    '',
    qr,
    `Or type the pairing code: ${created.code}`,
    `It works once and expires in ${minutes} minutes.`,
    '',
  ].join('\n'))
}
