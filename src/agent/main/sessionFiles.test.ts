import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))
vi.mock('../../main/runtime/runtimeManager', () => ({
  runtimes: { resolve: h.resolve },
}))

import { deleteSession, listSessions, loadSessionTranscript } from './sessionFiles'
import { formatLocator } from '../../main/runtime/locator'
import type { Runtime } from '../../main/runtime/types'

const norm = (value: string): string => value.replace(/\\/g, '/')

function runtimeWithFiles(files: Record<string, string>, id = 'local'): Runtime {
  const normalizedFiles = new Map(Object.entries(files).map(([filePath, content]) => [norm(filePath), content]))
  return {
    id,
    file: {
      readFile: vi.fn(async (filePath: string) => {
        const content = normalizedFiles.get(norm(filePath))
        if (content == null) throw new Error(`missing: ${filePath}`)
        return content
      }),
      readDir: vi.fn(async () => [...normalizedFiles.keys()].map((filePath) => ({
        name: filePath.slice(filePath.lastIndexOf('/') + 1),
        path: filePath,
        isDirectory: false,
      }))),
      remove: vi.fn(async () => {}),
    },
  } as unknown as Runtime
}

const sessionPath = '/work/.cate/pi-agent/sessions/--work--/session.jsonl'

beforeEach(() => {
  h.resolve.mockReset()
})

describe('loadSessionTranscript', () => {
  it('replays persisted messages while tolerating malformed and unknown entries', async () => {
    const transcript = [
      '{not-json',
      JSON.stringify({ type: 'model_change', modelId: 'model-before-message' }),
      JSON.stringify({
        type: 'message',
        id: 'user-entry',
        timestamp: '2026-07-15T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'ignored' }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-07-15T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'text', text: 'answer' },
          ],
          usage: { input: 7, output: 3, cacheRead: 'bad', cacheWrite: 2, cost: { total: 0.04 } },
          stopReason: 'stop',
        },
      }),
      JSON.stringify({ type: 'compaction' }),
      JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'orphan', content: 'ignored' } }),
      JSON.stringify({ type: 'message', message: { role: 'bashExecution', command: 'npm test' } }),
      JSON.stringify({ type: 'future_entry', value: 1 }),
    ].join('\n')
    h.resolve.mockReturnValue(runtimeWithFiles({ [sessionPath]: transcript }))

    const messages = await loadSessionTranscript(sessionPath)

    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({
      type: 'user', text: 'hello', entryId: 'user-entry', createdAt: Date.parse('2026-07-15T10:00:00.000Z'),
    })
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      text: 'answer',
      thinking: 'reasoning',
      model: 'model-before-message',
      streaming: false,
      stopReason: 'stop',
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 2, total: 0.04 },
    })
    expect(messages[2]).toMatchObject({ type: 'system', text: 'Context compacted.', kind: 'info' })
    expect(messages[3]).toMatchObject({ type: 'system', text: 'bash: npm test', kind: 'info' })
  })

  it('merges tool results and normalizes persisted subagent details for renderer replay', async () => {
    const transcript = [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { task: 'inspect' } }],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'completed' }],
          details: {
            mode: 'parallel',
            results: [
              null,
              {
                agent: 'reviewer',
                agentSource: 'project',
                task: 'inspect',
                exitCode: 0,
                messages: [{
                  role: 'assistant',
                  content: [
                    { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } },
                    { type: 'text', text: 'first' },
                    { type: 'text', text: 'final' },
                  ],
                }],
                usage: { input: 4, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 3 },
                model: 'test-model',
                step: 2,
              },
            ],
          },
        },
      }),
    ].join('\n')
    h.resolve.mockReturnValue(runtimeWithFiles({ [sessionPath]: transcript }))

    const messages = await loadSessionTranscript(sessionPath)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'call-1',
      name: 'subagent',
      args: { task: 'inspect' },
      status: 'success',
      result: 'completed',
      subagent: {
        mode: 'parallel',
        results: [{
          agent: 'reviewer',
          agentSource: 'project',
          task: 'inspect',
          exitCode: 0,
          parts: [
            { type: 'toolCall', toolCall: { name: 'read', args: { path: 'a.ts' } } },
            { type: 'text', text: 'first' },
            { type: 'text', text: 'final' },
          ],
          finalText: 'final',
          usage: { input: 4, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 3 },
          model: 'test-model',
          step: 2,
        }],
      },
    })
  })

  it('records failed tool results as errors with a stable fallback message', async () => {
    const transcript = [
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'failed', name: 'bash', arguments: {} }] },
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'toolResult', toolCallId: 'failed', content: [], isError: true },
      }),
    ].join('\n')
    h.resolve.mockReturnValue(runtimeWithFiles({ [sessionPath]: transcript }))

    expect(await loadSessionTranscript(sessionPath)).toMatchObject([{
      type: 'tool', toolCallId: 'failed', status: 'error', error: 'Tool reported an error', result: undefined,
    }])
  })
})

describe('session listing and deletion safety', () => {
  it('summarizes valid files, ignores unreadable/invalid sessions, and sorts newest first', async () => {
    const dir = '/work/.cate/pi-agent/sessions/--work--'
    const files = {
      [`${dir}/older.jsonl`]: [
        JSON.stringify({ type: 'session', id: 'older', cwd: '/work', timestamp: '2026-07-14T09:00:00Z' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: '  First\n prompt  ' } }),
        JSON.stringify({ type: 'model_change', provider: 'openai', modelId: 'old-model' }),
        JSON.stringify({ type: 'session_info', sessionName: 'Renamed session' }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [] } }),
      ].join('\n'),
      [`${dir}/newer.jsonl`]: [
        JSON.stringify({ type: 'session', id: 'newer', cwd: '/work', timestamp: '2026-07-15T09:00:00Z' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'Newest prompt' } }),
      ].join('\n'),
      [`${dir}/invalid.jsonl`]: JSON.stringify({ type: 'message', message: { role: 'user', content: 'no header' } }),
    }
    const runtime = runtimeWithFiles(files)
    h.resolve.mockReturnValue(runtime)

    const sessions = await listSessions('/work')

    expect(sessions.map((session) => session.id)).toEqual(['newer', 'older'])
    expect(sessions[0]).toMatchObject({ title: 'Newest prompt', named: false, messageCount: 1 })
    expect(sessions[1]).toMatchObject({
      title: 'Renamed session', named: true, messageCount: 2, lastModel: { provider: 'openai', model: 'old-model' },
    })
  })

  it('rejects reads and deletes outside the pi sessions directory before resolving a runtime', async () => {
    await expect(loadSessionTranscript('/work/notes.jsonl')).rejects.toThrow('not a pi session file')
    await expect(deleteSession('/work/.cate/pi-agent/sessions/readme.txt')).rejects.toThrow('not a pi session file')
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('routes a remote delete to its owning runtime using the decoded host path', async () => {
    const remotePath = '/srv/work/.cate/pi-agent/sessions/--srv-work--/remote.jsonl'
    const runtime = runtimeWithFiles({}, 'server-1')
    h.resolve.mockReturnValue(runtime)

    await deleteSession(formatLocator({ runtimeId: 'server-1', path: remotePath }))

    expect(h.resolve).toHaveBeenCalledWith('server-1')
    expect(runtime.file.remove).toHaveBeenCalledWith(remotePath)
  })
})
