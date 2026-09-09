import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
import { runRipgrepSearch } from './engine'

test('ripgrep JSON preserves filenames split inside a UTF-8 character', () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
  const path = '/repo/café.ts'
  const events = [
    { type: 'begin', data: { path: { text: path } } },
    { type: 'match', data: { path: { text: path }, lines: { text: 'é\n' }, line_number: 1, submatches: [{ match: { text: 'é' }, start: 0, end: 2 }] } },
    { type: 'end', data: { path: { text: path } } },
  ]
  const onBatch = vi.fn()
  runRipgrepSearch('rg', { query: 'é' }, '/repo', [], { onBatch, onDone: vi.fn() })
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')
  for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]))
  child.emit('close', 0)
  expect(onBatch.mock.calls[0][0][0].path).toBe(path)
})
