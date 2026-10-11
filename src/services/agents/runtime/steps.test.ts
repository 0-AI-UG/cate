import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentStepOf } from './steps'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('agentStepOf', () => {
  const call = (name: string, input: unknown) => ({ sessionId: 's', name, input, output: undefined })

  it('names a step by the checkout files an edit touched, relative to it', () => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cate-steps-')))
    const patch = `*** Begin Patch\n*** Update File: ${path.join(dir, 'a.ts')}\n@@\n-a\n+b\n*** Add File: b.ts\n+c\n*** End Patch`
    expect(agentStepOf(call('apply_patch', { command: patch }), dir, 't')).toEqual({ tool: 'apply_patch', subject: 'a.ts, b.ts', at: 't' })
  })

  it('puts a path in the checkout relative to it, and leaves one outside as it is', () => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cate-steps-')))
    expect(agentStepOf(call('Read', { file_path: path.join(dir, 'src', 'a.ts') }), dir, 't').subject).toBe('src/a.ts')
    expect(agentStepOf(call('Read', { file_path: '/etc/hosts' }), dir, 't').subject).toBe('/etc/hosts')
    expect(agentStepOf(call('Bash', { command: 'ls -la' }), dir, 't').subject).toBe('ls -la')
    expect(agentStepOf(call('Read', { file_path: path.join(dir, 'a.ts') }), null, 't').subject).toBe(path.join(dir, 'a.ts'))
  })
})
