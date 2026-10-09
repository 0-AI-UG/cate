import { describe, expect, it } from 'vitest'
import {
  ArgError,
  arr,
  bool,
  cateApiTimeoutMs,
  cliAccessDenied,
  custom,
  DEFAULT_API_TIMEOUT_MS,
  defineCateApi,
  defineCliArea,
  indexCateApi,
  num,
  obj,
  oneOf,
  opt,
  panel,
  record,
  str,
  validateCateArgs,
} from '../contract'
import { uiApi, versionApi } from './api'

// Areas as modules declare them (the kernel knows none).
const TEST_AREAS = {
  terminal: defineCliArea({
    label: 'Terminal',
    read: { key: 'cliTerminalReadEnabled', code: 'terminal-read-disabled', detail: 'read' },
    control: { key: 'cliTerminalInputEnabled', code: 'terminal-input-disabled', detail: 'input' },
  }),
  panel: defineCliArea({
    label: 'Panels',
    read: { key: 'cliPanelReadEnabled', code: 'panel-read-disabled', detail: 'read' },
    control: { key: 'cliPanelControlEnabled', code: 'panel-control-disabled', detail: 'control' },
  }),
  notify: defineCliArea({
    label: 'Notifications',
    control: { key: 'cliNotifyEnabled', code: 'notify-disabled', detail: 'notify' },
  }),
}


const demo = defineCateApi(
  'demo',
  {
    run: {
      access: 'control',
      handler: 'service',
      args: {
        text: str.nonEmpty(),
        count: opt(num.int().min(1).max(5), 2),
        mode: opt(oneOf('a', 'b')),
        flags: opt(arr(bool)),
        point: opt(obj({ x: num, y: num })),
        map: opt(record(str)),
        target: opt(custom('id or [x,y]', (v): v is number => typeof v === 'number')),
        panelId: opt(panel('terminal')),
      },
      timeoutMs: (args) => args.count * 1_000,
    },
    'note.add': { access: 'read', handler: 'session', args: { body: str } },
    loose: { access: 'read', handler: 'session', extraArgs: true, args: { tabId: str } },
  },
  { area: TEST_AREAS.terminal },
)

describe('defineCateApi', () => {
  it('names methods, keeps area and derives the session panel type', () => {
    expect(demo.methods.run.method).toBe('cate.demo.run')
    expect(demo.methods['note.add'].method).toBe('cate.demo.note.add')
    expect(demo.methods['note.add'].panelType).toBe('demo')
    expect(demo.methods.run.panelType).toBeUndefined()
    expect(demo.methods.run.area).toBe(TEST_AREAS.terminal)
    expect(versionApi.methods.version.method).toBe('cate.version')
    expect(uiApi.methods.notify.method).toBe('cate.ui.notify')
  })

  it('rejects malformed declarations', () => {
    expect(() => defineCateApi('Bad', {})).toThrow(/namespace/)
    expect(() => defineCateApi('x', { 'a..b': { access: 'read', handler: 'service' } })).toThrow(/method name/)
    expect(() => defineCateApi('x', { a: { access: 'read', handler: 'service', target: 'auto' } })).toThrow(/session methods only/)
    expect(() => defineCateApi('x', { a: { access: 'read', handler: 'session', args: { panelId: str } } })).toThrow(/reserved/)
    expect(() => defineCateApi('x', { a: { access: 'read', handler: 'service', args: { a: str.rest(), b: str.rest() } } })).toThrow(/one rest/)
  })

  it('refuses duplicate method names across namespaces', () => {
    expect(() => indexCateApi([demo, demo])).toThrow(/duplicate/)
    expect(indexCateApi([demo, versionApi]).get('cate.version')).toBe(versionApi.methods.version)
  })

  it('computes timeouts from the spec', () => {
    expect(cateApiTimeoutMs(demo.methods.run, { count: 3 })).toBe(3_000)
    expect(cateApiTimeoutMs(demo.methods['note.add'], {})).toBe(DEFAULT_API_TIMEOUT_MS)
  })
})

describe('argument validation', () => {
  const run = demo.methods.run

  it('applies defaults and keeps valid values', () => {
    expect(validateCateArgs(run, { text: 'hi' })).toEqual({ text: 'hi', count: 2 })
    expect(validateCateArgs(run, {
      text: 'hi', count: 5, mode: 'b', flags: [true], point: { x: 1, y: 2 }, map: { a: 'b' }, target: 4, panelId: 'abc',
    })).toMatchObject({ count: 5, mode: 'b', flags: [true], point: { x: 1, y: 2 }, target: 4 })
  })

  it.each([
    [{}, /missing text/],
    [{ text: '  ' }, /non-empty/],
    [{ text: 1 }, /string/],
    [{ text: 'x', count: 1.5 }, /integer/],
    [{ text: 'x', count: 9 }, /<= 5/],
    [{ text: 'x', mode: 'c' }, /a\|b/],
    [{ text: 'x', flags: ['y'] }, /flags\[0\]/],
    [{ text: 'x', point: { x: 1 } }, /missing point\.y/],
    [{ text: 'x', map: { a: 1 } }, /map\.a/],
    [{ text: 'x', target: 'no' }, /id or \[x,y\]/],
    [{ text: 'x', panelId: '' }, /non-empty/],
    [{ text: 'x', other: 1 }, /unknown argument other/],
  ])('rejects %j', (args, message) => {
    expect(() => validateCateArgs(run, args)).toThrow(ArgError)
    expect(() => validateCateArgs(run, args)).toThrow(message)
  })

  it('passes undeclared keys through only with extraArgs', () => {
    expect(validateCateArgs(demo.methods.loose, { tabId: 't', emit: false })).toEqual({ tabId: 't', emit: false })
    expect(() => validateCateArgs(demo.methods['note.add'], { body: 'b', emit: false })).toThrow(/unknown/)
  })
})

describe('cliAccessDenied', () => {
  const settings = (values: Record<string, unknown>) => (key: string) => values[key]

  it('requires the master switch', () => {
    expect(cliAccessDenied(TEST_AREAS.terminal, 'read', settings({ cliTerminalReadEnabled: true }))).toMatch(/^cli-disabled/)
    expect(cliAccessDenied(undefined, 'read', settings({ cliEnabled: true }))).toBeNull()
  })

  it('checks the area cell for the access class', () => {
    const on = settings({ cliEnabled: true, cliTerminalReadEnabled: true })
    expect(cliAccessDenied(TEST_AREAS.terminal, 'read', on)).toBeNull()
    expect(cliAccessDenied(TEST_AREAS.terminal, 'control', on)).toBe(
      'terminal-input-disabled: enable Terminal → Control in Cate Settings → CLI',
    )
  })

  it('leaves read methods of an area without a read cell behind the master switch only', () => {
    expect(cliAccessDenied(TEST_AREAS.notify, 'read', settings({ cliEnabled: true }))).toBeNull()
    expect(cliAccessDenied(TEST_AREAS.notify, 'control', settings({ cliEnabled: true }))).toMatch(/^notify-disabled/)
  })
})
