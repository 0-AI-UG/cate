import { afterEach, expect, it } from 'vitest'
import { combineSinks, createLogger, formatLogLine, formatLogMessage, installLogSink, type LogRecord } from './contract'

afterEach(() => installLogSink(null))

it('formats printf placeholders and appends leftover arguments', () => {
  expect(formatLogMessage('%s of %s failed: %O', ['write', 'a.json', { code: 'EIO' }]))
    .toBe('write of a.json failed: {"code":"EIO"}')
  expect(formatLogMessage('n=%d %i %%', [1.5, 2.7])).toBe('n=1.5 2 %')
  expect(formatLogMessage('missing %s', [])).toBe('missing %s')
  expect(formatLogMessage('extra', ['a', 2])).toBe('extra a 2')
})

it('routes records through the installed sink with scope and child scope', () => {
  const records: LogRecord[] = []
  installLogSink(combineSinks(() => { throw new Error('broken sink') }, (r) => records.push(r)))
  const log = createLogger('state')
  log.warn('x %s', 'y')
  log.child('file').error('boom')
  expect(records.map((r) => [r.level, r.scope, r.message, r.args])).toEqual([
    ['warn', 'state', 'x %s', ['y']],
    ['error', 'state:file', 'boom', []],
  ])
})

it('never throws into the caller when the sink throws', () => {
  installLogSink(() => { throw new Error('EIO') })
  expect(() => createLogger('x').info('hello')).not.toThrow()
})

it('formats one line per record', () => {
  const line = formatLogLine({ level: 'info', scope: 'daemon', message: 'up %d', args: [3], time: new Date(2026, 0, 2, 3, 4, 5, 6).getTime() })
  expect(line).toBe('[2026-01-02 03:04:05.006] [info] [daemon] up 3')
})
