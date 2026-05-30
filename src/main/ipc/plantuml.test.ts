import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'child_process'
import { buildPlantumlArgs, renderLocal } from './plantuml'

const spawnMock = vi.mocked(spawn)

/** Minimal fake of a spawned child: EventEmitter for 'close'/'error', plus
 *  stdout/stderr EventEmitters and a stub stdin. */
function makeChild() {
  const child = new EventEmitter() as unknown as {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    emit: (event: string, ...args: unknown[]) => boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  child.kill = vi.fn()
  return child
}

beforeEach(() => {
  spawnMock.mockReset()
})

describe('buildPlantumlArgs', () => {
  it('produces java -jar <jar> -tsvg -pipe', () => {
    expect(buildPlantumlArgs('/opt/plantuml.jar')).toEqual([
      '-jar',
      '/opt/plantuml.jar',
      '-tsvg',
      '-pipe',
    ])
  })
})

describe('renderLocal', () => {
  it('does not spawn and errors when the jar path is blank', async () => {
    const res = await renderLocal('@startuml\n@enduml', '   ')
    expect(res.error).toMatch(/No PlantUML jar configured/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('writes the source to stdin and returns the SVG on a clean exit', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child as never)
    const src = '@startuml\nBob -> Alice\n@enduml'
    const p = renderLocal(src, '/x.jar')
    child.stdout.emit('data', Buffer.from('<svg>ok</svg>'))
    child.emit('close', 0)
    const res = await p
    expect(res).toEqual({ svg: '<svg>ok</svg>' })
    expect(spawnMock).toHaveBeenCalledWith('java', ['-jar', '/x.jar', '-tsvg', '-pipe'], expect.anything())
    expect(child.stdin.end).toHaveBeenCalledWith(src)
  })

  it('maps a missing java binary (ENOENT) to an actionable error', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child as never)
    const p = renderLocal('x', '/x.jar')
    const err = Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' })
    child.emit('error', err)
    expect((await p).error).toMatch(/Java not found/)
  })

  it('surfaces stderr on a non-zero exit', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child as never)
    const p = renderLocal('x', '/x.jar')
    child.stderr.emit('data', Buffer.from('Syntax error in diagram'))
    child.emit('close', 1)
    expect((await p).error).toContain('Syntax error in diagram')
  })

  it('errors when the output is not an SVG even on exit 0', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child as never)
    const p = renderLocal('x', '/x.jar')
    child.stdout.emit('data', Buffer.from('not an image'))
    child.emit('close', 0)
    expect((await p).error).toMatch(/exited with code 0/)
  })

  it('times out and kills the child', async () => {
    vi.useFakeTimers()
    try {
      const child = makeChild()
      spawnMock.mockReturnValue(child as never)
      const p = renderLocal('x', '/x.jar')
      vi.advanceTimersByTime(15_000)
      const res = await p
      expect(res.error).toMatch(/timed out/)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })
})
