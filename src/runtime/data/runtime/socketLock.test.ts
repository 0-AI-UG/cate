import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireRuntimeSocket, socketAnswers, type SocketAcquire } from './socketLock'
import { writeRuntimeInfo } from './runtimeInfo'

let dir: string
let child: ChildProcess | null = null
const servers: net.Server[] = []

afterEach(async () => {
  child?.kill('SIGKILL')
  child = null
  for (const server of servers.splice(0)) server.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('acquireRuntimeSocket', () => {
  it('lets one of two racing starts bind over a stale socket whose owner pid is not a daemon', async () => {
    dir = fs.mkdtempSync('/tmp/cate-lock-')
    // The recorded owner is alive but is no daemon (a reused pid).
    child = spawn('sleep', ['30'], { stdio: 'ignore' })
    await writeRuntimeInfo(dir, { pid: child.pid! } as never)
    const options = { ownerExitMs: 300, probeTimeoutMs: 200 }
    const first = acquireRuntimeSocket(dir, 'abc', options)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const second = acquireRuntimeSocket(dir, 'abc', options)
    const results: SocketAcquire[] = await Promise.all([first, second])
    for (const result of results) if (result.kind === 'acquired') servers.push(result.server)
    expect(results.map((result) => result.kind).sort()).toEqual(['acquired', 'running'])
    expect(await socketAnswers(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.sock'))!), 500)).toBe(true)
  })
})
