import { describe, expect, test } from 'vitest'
import { decideCensusAction, decideUpdateAction, sanitizeUsageProps } from './decisions'

describe('sanitizeUsageProps', () => {
  test('keeps small primitives and drops everything else', () => {
    const out = sanitizeUsageProps({ type: 'terminal', count: 3, ok: true, nested: { a: 1 }, fn: () => {} })
    expect(out).toEqual({ type: 'terminal', count: 3, ok: true })
  })

  test('clamps long strings and caps the number of keys', () => {
    const long = 'x'.repeat(200)
    const many: Record<string, string> = {}
    for (let i = 0; i < 20; i++) many[`k${i}`] = 'v'
    expect(sanitizeUsageProps({ note: long }).note).toHaveLength(48)
    expect(Object.keys(sanitizeUsageProps(many)).length).toBe(6)
  })

  test('returns an empty object for non-object input', () => {
    expect(sanitizeUsageProps(null)).toEqual({})
    expect(sanitizeUsageProps('nope')).toEqual({})
  })
})

describe('decideUpdateAction', () => {
  test('first launch: emits app_install and persists the version', () => {
    const action = decideUpdateAction('1.0.0', {})
    expect(action.kind).toBe('first_install')
    expect(action.nextState).toEqual({ lastSeenVersion: '1.0.0' })
  })

  test('same version: no event, state unchanged', () => {
    const state = { lastSeenVersion: '1.0.0' }
    const action = decideUpdateAction('1.0.0', state)
    expect(action.kind).toBe('no_change')
    expect(action.nextState).toBe(state)
  })

  test('version changed: emits app_updated and persists the new version', () => {
    const action = decideUpdateAction('1.1.0', { lastSeenVersion: '1.0.0' })
    expect(action.kind).toBe('version_changed')
    if (action.kind !== 'version_changed') return
    expect(action.emit).toBe('app_updated')
    expect(action.from).toBe('1.0.0')
    expect(action.to).toBe('1.1.0')
    expect(action.nextState).toEqual({ lastSeenVersion: '1.1.0' })
  })

  test('version downgrade is still treated as a change (defensive)', () => {
    const action = decideUpdateAction('0.9.0', { lastSeenVersion: '1.0.0' })
    expect(action.kind).toBe('version_changed')
  })

  test('does not lose unrelated fields when merging state', () => {
    const state = {
      lastSeenVersion: '1.0.0',
      // Hypothetical future field: should round-trip untouched.
      ...(({ futureField: 'preserve me' } as unknown) as object),
    }
    const action = decideUpdateAction('1.1.0', state)
    if (action.kind !== 'version_changed') throw new Error('expected version_changed')
    expect((action.nextState as Record<string, unknown>).futureField).toBe('preserve me')
  })
})

describe('decideCensusAction', () => {
  test('previously-silent install (lastSeenVersion set, no prior install-id): backfills once', () => {
    const action = decideCensusAction({ lastSeenVersion: '1.0.0' }, false)
    expect(action.kind).toBe('backfill')
    if (action.kind !== 'backfill') return
    expect(action.fromVersion).toBe('1.0.0')
    expect(action.nextState).toEqual({ lastSeenVersion: '1.0.0', censusSent: true })
  })

  test('genuinely-new install (no lastSeenVersion): no backfill: app_install covers it', () => {
    expect(decideCensusAction({}, false).kind).toBe('none')
  })

  test('install that already sent telemetry (install-id pre-existed): no backfill', () => {
    expect(decideCensusAction({ lastSeenVersion: '1.0.0' }, true).kind).toBe('none')
  })

  test('census already sent: never re-fires, even if other conditions hold', () => {
    expect(decideCensusAction({ lastSeenVersion: '1.0.0', censusSent: true }, false).kind).toBe('none')
  })

  test('preserves unrelated state fields when marking censusSent', () => {
    const action = decideCensusAction(
      { lastSeenVersion: '1.0.0', ...(({ futureField: 'keep' } as unknown) as object) },
      false,
    )
    if (action.kind !== 'backfill') throw new Error('expected backfill')
    expect((action.nextState as Record<string, unknown>).futureField).toBe('keep')
    expect(action.nextState.censusSent).toBe(true)
  })
})
