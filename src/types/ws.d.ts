declare module 'ws' {
  import { EventEmitter } from 'events'
  import type { AddressInfo } from 'net'

  export type RawData = Buffer | ArrayBuffer | Buffer[]

  export default class WebSocket extends EventEmitter {
    static readonly CONNECTING: number
    static readonly OPEN: number
    readonly readyState: number
    constructor(address: string)
    send(data: RawData | string, options?: { binary?: boolean }): void
    close(code?: number, reason?: string): void
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { host: string; port: number })
    address(): AddressInfo | string
    close(): void
  }
}
