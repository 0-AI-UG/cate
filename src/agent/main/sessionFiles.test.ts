import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { loadSessionTranscript, type RendererToolMessage } from './sessionFiles'

// loadSessionTranscript guards on the path containing the sessions segment and
// ending in .jsonl, so the fixture has to live under a matching dir.
let dir: string
let file: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-sess-'))
  dir = path.join(dir, '.cate', 'pi-agent', 'sessions', 'ws')
  await fs.mkdir(dir, { recursive: true })
  file = path.join(dir, '123_abc.jsonl')
})

afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}) })

function line(obj: unknown): string { return JSON.stringify(obj) }

async function transcript(lines: unknown[]): Promise<RendererToolMessage[]> {
  await fs.writeFile(file, lines.map(line).join('\n'))
  const out = await loadSessionTranscript(file)
  return out.filter((m): m is RendererToolMessage => m.type === 'tool')
}

describe('loadSessionTranscript — cate-control tools', () => {
  it('keeps the raw cate_* name (renderer matches it like plan_complete)', async () => {
    const tools = await transcript([
      { type: 'message', id: 'e1', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 't1', name: 'cate_browser', arguments: { op: 'read', panel: 'p1' } },
      ] } },
    ])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('cate_browser')
    expect(tools[0].args).toEqual({ op: 'read', panel: 'p1' })
  })

  it('rebuilds the structured result from details (not the prose content)', async () => {
    const tools = await transcript([
      { type: 'message', id: 'e1', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 't1', name: 'cate_browser', arguments: { op: 'read', panel: 'p1' } },
      ] } },
      { type: 'message', id: 'e2', message: {
        role: 'toolResult', toolCallId: 't1',
        content: [{ type: 'text', text: 'browser ok: {"text":"hi"}' }],
        details: { ok: true, result: { browser: 'Browser', text: 'hi' } },
      } },
    ])
    expect(tools[0].status).toBe('success')
    // Result is JSON the renderer parses back into an object — not the prose.
    expect(JSON.parse(tools[0].result!)).toEqual({ browser: 'Browser', text: 'hi' })
  })

  it('surfaces a failed cate op as an error from details.ok=false', async () => {
    const tools = await transcript([
      { type: 'message', id: 'e1', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 't1', name: 'cate_panel', arguments: { op: 'close', panel: 'p9' } },
      ] } },
      { type: 'message', id: 'e2', message: {
        role: 'toolResult', toolCallId: 't1',
        content: [{ type: 'text', text: 'panel failed: no such panel' }],
        details: { ok: false, error: 'no such panel' },
      } },
    ])
    expect(tools[0].name).toBe('cate_panel')
    expect(tools[0].status).toBe('error')
    expect(tools[0].error).toBe('no such panel')
    expect(tools[0].result).toBeUndefined()
  })

  it('leaves non-cate tools untouched', async () => {
    const tools = await transcript([
      { type: 'message', id: 'e1', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } },
      ] } },
      { type: 'message', id: 'e2', message: {
        role: 'toolResult', toolCallId: 't1',
        content: [{ type: 'text', text: 'a.ts' }],
      } },
    ])
    expect(tools[0].name).toBe('bash')
    expect(tools[0].result).toBe('a.ts')
  })
})
