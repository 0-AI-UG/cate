import { Duplex } from 'stream'
import { randomUUID } from 'crypto'
import type { Runtime } from '../runtime/types'

/** Shared byte/credit adapter for outbound and accepted reverse tunnels.
 * Credit follows readable demand: a full Node buffer cannot grant the daemon
 * permission to keep filling it while the HTTP/socket consumer is paused. */
class TunnelDuplex extends Duplex {
  private pendingCredit = 0
  private tunnelClosed = false
  constructor(private runtime: Runtime, private connId: string) { super() }
  override _read(): void {
    if (!this.pendingCredit || this.tunnelClosed) return
    const credit = this.pendingCredit
    this.pendingCredit = 0
    this.runtime.tunnel.ack(this.connId, credit)
  }
  receive(data: Buffer | null): void {
    if (this.tunnelClosed || this.destroyed) return
    if (data === null) { this.tunnelClosed = true; this.push(null); return }
    this.pendingCredit += data.length
    if (this.push(data)) this._read()
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try { this.runtime.tunnel.write(this.connId, chunk.toString('base64')); callback() }
    catch (error) { callback(error instanceof Error ? error : new Error(String(error))) }
  }
  private closeTunnel(): void {
    if (this.tunnelClosed) return
    this.tunnelClosed = true
    this.pendingCredit = 0
    try { this.runtime.tunnel.close(this.connId) } catch { /* already gone */ }
  }
  override _final(callback: (error?: Error | null) => void): void { this.closeTunnel(); callback() }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void { this.closeTunnel(); callback(error) }
}

/** Deliver accepted-tunnel bytes through the same demand/credit owner as open(). */
export function receiveTunnelData(stream: Duplex, data: Buffer | null): void {
  if (!(stream instanceof TunnelDuplex)) throw new Error('Tunnel data requires a tunnel-owned stream')
  stream.receive(data)
}

export async function openTunnelDuplex(runtime: Runtime, port: number): Promise<Duplex> {
  const id = `exttun_${randomUUID()}`
  const stream = new TunnelDuplex(runtime, id)
  try {
    await runtime.tunnel.open(id, port,
      (connId, data) => { if (connId === id) stream.receive(Buffer.from(data, 'base64')) },
      connId => { if (connId === id) stream.receive(null) },
    )
    return stream
  } catch (error) { stream.destroy(); throw error }
}

export function reverseDuplex(runtime: Runtime, connId: string): Duplex {
  return new TunnelDuplex(runtime, connId)
}
