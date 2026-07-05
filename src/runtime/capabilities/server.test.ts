// =============================================================================
// End-to-end test for the server + tunnel capabilities, using the REAL
// electron-free implementations (no mocks). Spawns a tiny HTTP server via the
// server capability (asserting the ready probe resolves), tunnels a raw HTTP
// request through the tunnel capability to its loopback port, and asserts the
// response body. Also asserts the ready-probe timeout path rejects.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { createServerCapability } from './server'
import { createTunnelCapability } from './tunnel'

const HTTP_SERVER_SRC =
  "const http=require('http');http.createServer((q,s)=>s.end('hello-ext')).listen(process.env.PORT,'127.0.0.1')"

describe('server + tunnel capabilities (e2e)', () => {
  it('starts a server (ready probe), tunnels a request, then stops it', async () => {
    const server = createServerCapability()
    const tunnel = createTunnelCapability()

    let exitCode: number | null | undefined
    const exited = new Promise<void>((resolve) => {
      void server.start(
        {
          id: 'srv1',
          command: [process.execPath, '-e', HTTP_SERVER_SRC],
          cwd: process.cwd(),
          env: {},
          portEnv: 'PORT',
          readyPath: '/',
          readyTimeoutMs: 5000,
        },
        () => { /* output ignored */ },
        (_id, code) => { exitCode = code; resolve() },
      ).then(async (handle) => {
        // Ready probe passed → we got a bound port.
        expect(handle.port).toBeGreaterThan(0)
        expect(handle.pid).toBeGreaterThan(0)

        // Tunnel a raw HTTP/1.1 request to the server's loopback port and
        // accumulate the base64 data chunks.
        const chunks: Buffer[] = []
        const closed = new Promise<void>((res) => {
          void tunnel.open(
            'conn1',
            handle.port,
            (_connId, b64) => { chunks.push(Buffer.from(b64, 'base64')) },
            () => res(),
          ).then(() => {
            tunnel.write('conn1', Buffer.from('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n').toString('base64'))
          })
        })

        await closed
        const body = Buffer.concat(chunks).toString('utf-8')
        expect(body).toContain('hello-ext')

        tunnel.closeAll()
        server.stop('srv1')
      })
    })

    await exited
    // SIGTERM exit: code is null (terminated by signal) or 0.
    expect(exitCode === null || exitCode === 0).toBe(true)
  }, 15000)

  it('rejects when the ready probe times out (server never listens)', async () => {
    const server = createServerCapability()
    await expect(
      server.start(
        {
          id: 'srv2',
          command: [process.execPath, '-e', 'setTimeout(()=>{},10000)'],
          cwd: process.cwd(),
          env: {},
          portEnv: 'PORT',
          readyPath: '/',
          readyTimeoutMs: 800,
        },
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/timed out/)
  }, 15000)
})
