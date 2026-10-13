import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startAskpass, type AskpassServer } from './askpass'

const run = (env: NodeJS.ProcessEnv, prompt: string) => new Promise<{ code: number; stdout: string }>((resolve) => {
  execFile(env.SSH_ASKPASS!, [prompt], { env }, (err, stdout) => resolve({ code: err ? Number(err.code ?? 1) : 0, stdout }))
})

describe.skipIf(process.platform === 'win32')('startAskpass', () => {
  let server: AskpassServer | null = null
  let dir = ''
  afterEach(async () => {
    await server?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('hands ssh the answer the person gives, and fails when they cancel', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askpass-'))
    const asked: { machine: string; prompt: string }[] = []
    server = startAskpass({
      dir,
      node: process.execPath,
      ask: async (request, _signal) => {
        asked.push(request)
        return request.prompt.includes('code') ? null : 'hunter2'
      },
    })
    const env = server.env({ kind: 'ssh', target: { destination: 'me@box' } }, 'owner')
    expect(await run(env, "me@box's password: ")).toEqual({ code: 0, stdout: 'hunter2\n' })
    expect(asked).toEqual([{ machine: 'me@box', prompt: "me@box's password: " }])
    expect((await run(env, 'Verification code: ')).code).not.toBe(0)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(server.controlPath).toBe(path.join(dir, '%C'))
  })

  it('withdraws only the questions of the ssh that went away', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askpass-'))
    const withdrawn: string[] = []
    const asked: string[] = []
    let answerKept = () => {}
    server = startAskpass({
      dir,
      node: process.execPath,
      ask: (request, signal) => new Promise((resolve) => {
        asked.push(request.prompt)
        let answered = false
        signal.addEventListener('abort', () => { if (!answered) { withdrawn.push(request.prompt); resolve(null) } })
        if (request.prompt === 'kept') answerKept = () => { answered = true; resolve('answer') }
      }),
    })
    const machine = { kind: 'ssh' as const, target: { destination: 'me@box' } }
    const cancelled = run(server.env(machine, 'a'), 'cancelled')
    const kept = run(server.env(machine, 'b'), 'kept')
    await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(2)
    server.withdraw('a')
    expect((await cancelled).code).not.toBe(0)
    answerKept()
    expect(await kept).toEqual({ code: 0, stdout: 'answer\n' })
    expect(withdrawn).toEqual(['cancelled'])
  })
})
