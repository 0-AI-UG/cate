import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { framePortOver, type ByteDuplex } from '@kernel/rpc/contract'
import { RpcServer } from '@kernel/rpc/runtime'
import { apiCapability } from '@kernel/api/contract'
import { ApiRouter, ApiTokenRegistry, acceptCallerHello, apiCapabilityImpl, registerKernelApi } from '@kernel/api/runtime'
import { CLI_VERSION, runCli, type CliDeps } from './engine'
import { connectSocket } from './socketPort'
import { CATE_API } from '@panels/api'

function serverDuplex(socket: net.Socket): ByteDuplex {
  return {
    write: (bytes) => { socket.write(bytes) },
    onData: (listener) => { socket.on('data', (c: Buffer) => listener(new Uint8Array(c.buffer, c.byteOffset, c.byteLength))) },
    onClose: (listener) => { socket.on('close', () => listener()) },
    close: () => { socket.destroy() },
  }
}

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

async function startRuntime(settings: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cate-cli-'))
  const socketPath = path.join(dir, 's.sock')
  const panels = [{ id: 'term-123456789', type: 'terminal' }]
  const tokens = new ApiTokenRegistry()
  const router = new ApiRouter({
    namespaces: CATE_API,
    document: { panel: (id) => panels.find((p) => p.id === id), panels: () => panels },
    presence: { activePanelId: () => undefined },
    sessions: { handleApi: async (panelId, method, args) => ({ text: `${panelId} ${method} ${JSON.stringify(args)}` }) },
    settings: { get: (key) => settings[key] },
    tokens,
  })
  registerKernelApi(router, { publishNotification: () => {} })
  const rpc = new RpcServer({ version: 'test', acceptHello: (hello) => acceptCallerHello(router, hello) })
  rpc.register(apiCapability, apiCapabilityImpl(router))
  const server = net.createServer((socket) => rpc.serve(framePortOver(serverDuplex(socket), 'stream')))
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanups.push(() => {
    rpc.close()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { socketPath, tokens }
}

async function cli(argv: string[], env: Record<string, string | undefined>) {
  const out: string[] = []
  const err: string[] = []
  const deps: CliDeps = {
    env,
    cwd: '/',
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    connect: (socketPath, token) => connectSocket(socketPath, token, CLI_VERSION),
  }
  const code = await runCli(argv, CATE_API, deps)
  return { code, out, err }
}

describe('cate CLI over the local socket', () => {
  it('calls the router as the caller its token names', async () => {
    const { socketPath, tokens } = await startRuntime({ cliEnabled: true, cliTerminalReadEnabled: true })
    const { token } = tokens.issue({ kind: 'cli', panelId: 'term-123456789' })
    const env = { CATE_SOCKET: socketPath, CATE_TOKEN: token }

    expect(await cli(['version'], env)).toMatchObject({ code: 0, out: ['10'] })
    expect(await cli(['terminal', 'read', '--panel', 'term-1', '--lines', '3'], env)).toMatchObject({
      code: 0,
      out: ['term-123456789 read {"lines":3}'],
    })
  })

  it('reports permission denials as API errors', async () => {
    const { socketPath, tokens } = await startRuntime({ cliEnabled: true })
    const { token } = tokens.issue({ kind: 'cli' })
    const result = await cli(['terminal', 'read', '--panel', 'term-1'], { CATE_SOCKET: socketPath, CATE_TOKEN: token })
    expect(result.code).toBe(1)
    expect(result.err[0]).toMatch(/^cate: cate\.terminal\.read: terminal-read-disabled/)
  })

  it('refuses an unknown token at hello', async () => {
    const { socketPath } = await startRuntime({ cliEnabled: true })
    const result = await cli(['version'], { CATE_SOCKET: socketPath, CATE_TOKEN: 'forged' })
    expect(result.code).toBe(3)
    expect(result.err[0]).toMatch(/unknown or revoked cate token/)
  })

  it('reports an unreachable socket', async () => {
    const result = await cli(['version'], { CATE_SOCKET: path.join(os.tmpdir(), 'no-such-cate.sock'), CATE_TOKEN: 't' })
    expect(result.code).toBe(3)
    expect(result.err[0]).toMatch(/cannot reach the workspace runtime/)
  })
})
