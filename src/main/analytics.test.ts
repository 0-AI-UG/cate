import { describe, expect, test, vi } from 'vitest'

// analytics.ts pulls in electron at module load (app/ipcMain/net types) and
// also pulls in ./store (which dynamic-imports electron-store). Stub both so
// the test runs in plain node — we only exercise pure functions here.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getLocale: () => 'en', isPackaged: false, getPath: () => '/tmp' },
  ipcMain: { on: vi.fn() },
  net: { request: vi.fn() },
}))
vi.mock('./store', () => ({ getSettingSync: () => true }))
vi.mock('./appContext', () => ({
  getCommonContext: () => ({
    install_id: 'test-install-id',
    app_version: '0.0.0-test',
    platform: 'darwin',
    arch: 'arm64',
    electron_version: '0',
    node_version: '0',
    chrome_version: '0',
    locale: 'en',
    is_packaged: false,
    os_release: 'test',
  }),
}))
vi.mock('./logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))

const { decideUpdateAction, sanitizeFeedbackPayload } = await import('./analytics')

describe('decideUpdateAction', () => {
  test('first launch: emits app_install, persists version, and queues prompt', () => {
    const action = decideUpdateAction('1.0.0', {})
    expect(action.kind).toBe('first_install')
    if (action.kind !== 'first_install') return
    expect(action.emit).toBe('app_install')
    expect(action.nextState).toEqual({
      lastSeenVersion: '1.0.0',
      pendingFeedbackForVersion: '1.0.0',
      pendingFeedbackFromVersion: '',
    })
    expect(action.prompt).toEqual({ from: '', to: '1.0.0' })
  })

  test('same version, no pending feedback: no event, no prompt, state unchanged', () => {
    const state = { lastSeenVersion: '1.0.0' }
    const action = decideUpdateAction('1.0.0', state)
    expect(action.kind).toBe('no_change')
    if (action.kind !== 'no_change') return
    expect(action.prompt).toBeUndefined()
    expect(action.nextState).toBe(state) // referentially unchanged
  })

  test('same version with pending feedback: re-prompts using stored from/to', () => {
    const state = {
      lastSeenVersion: '1.0.0',
      pendingFeedbackForVersion: '1.0.0',
      pendingFeedbackFromVersion: '0.9.0',
    }
    const action = decideUpdateAction('1.0.0', state)
    expect(action.kind).toBe('no_change')
    if (action.kind !== 'no_change') return
    expect(action.prompt).toEqual({ from: '0.9.0', to: '1.0.0' })
  })

  test('same version with pending feedback but no from-version: falls back to previous', () => {
    const state = { lastSeenVersion: '1.0.0', pendingFeedbackForVersion: '1.0.0' }
    const action = decideUpdateAction('1.0.0', state)
    if (action.kind !== 'no_change') throw new Error('expected no_change')
    expect(action.prompt).toEqual({ from: '1.0.0', to: '1.0.0' })
  })

  test('version changed: emits app_updated, queues prompt, persists new version + pending flags', () => {
    const action = decideUpdateAction('1.1.0', { lastSeenVersion: '1.0.0' })
    expect(action.kind).toBe('version_changed')
    if (action.kind !== 'version_changed') return
    expect(action.emit).toBe('app_updated')
    expect(action.from).toBe('1.0.0')
    expect(action.to).toBe('1.1.0')
    expect(action.prompt).toEqual({ from: '1.0.0', to: '1.1.0' })
    expect(action.nextState).toEqual({
      lastSeenVersion: '1.1.0',
      pendingFeedbackForVersion: '1.1.0',
      pendingFeedbackFromVersion: '1.0.0',
    })
  })

  test('version downgrade is still treated as a change (defensive)', () => {
    const action = decideUpdateAction('0.9.0', { lastSeenVersion: '1.0.0' })
    expect(action.kind).toBe('version_changed')
    if (action.kind !== 'version_changed') return
    expect(action.from).toBe('1.0.0')
    expect(action.to).toBe('0.9.0')
  })

  test('first launch always triggers the dialog prompt', () => {
    const action = decideUpdateAction('2.0.0', {})
    expect(action.kind).toBe('first_install')
    if (action.kind !== 'first_install') return
    expect(action.prompt).toBeDefined()
    expect(action.prompt.to).toBe('2.0.0')
    expect(action.prompt.from).toBe('')
    expect(action.nextState.pendingFeedbackForVersion).toBe('2.0.0')
  })

  test('major/minor version update triggers the dialog prompt', () => {
    const action = decideUpdateAction('2.0.0', { lastSeenVersion: '1.5.0' })
    expect(action.kind).toBe('version_changed')
    if (action.kind !== 'version_changed') return
    expect(action.prompt).toBeDefined()
    expect(action.prompt!.from).toBe('1.5.0')
    expect(action.prompt!.to).toBe('2.0.0')
    expect(action.nextState.pendingFeedbackForVersion).toBe('2.0.0')
    expect(action.nextState.pendingFeedbackFromVersion).toBe('1.5.0')
  })

  test('patch-only update does NOT trigger the dialog prompt', () => {
    const action = decideUpdateAction('1.0.1', { lastSeenVersion: '1.0.0' })
    expect(action.kind).toBe('version_changed')
    if (action.kind !== 'version_changed') return
    expect(action.emit).toBe('app_updated')
    expect(action.from).toBe('1.0.0')
    expect(action.to).toBe('1.0.1')
    expect(action.prompt).toBeUndefined()
    expect(action.nextState.pendingFeedbackForVersion).toBeUndefined()
    expect(action.nextState.pendingFeedbackFromVersion).toBeUndefined()
  })

  test('normal launch (same version, no pending) does NOT trigger dialog', () => {
    const action = decideUpdateAction('1.0.0', { lastSeenVersion: '1.0.0' })
    expect(action.kind).toBe('no_change')
    if (action.kind !== 'no_change') return
    expect(action.prompt).toBeUndefined()
  })

  test('does not lose unrelated fields when merging state', () => {
    const state = {
      lastSeenVersion: '1.0.0',
      // Hypothetical future field — should round-trip untouched.
      ...(({ futureField: 'preserve me' } as unknown) as object),
    }
    const action = decideUpdateAction('1.1.0', state)
    if (action.kind !== 'version_changed') throw new Error('expected version_changed')
    expect((action.nextState as Record<string, unknown>).futureField).toBe('preserve me')
  })
})

describe('sanitizeFeedbackPayload', () => {
  test('clamps rating into 1..5', () => {
    expect(sanitizeFeedbackPayload({ rating: 0 }).rating).toBe(1)
    expect(sanitizeFeedbackPayload({ rating: -3 }).rating).toBe(1)
    expect(sanitizeFeedbackPayload({ rating: 99 }).rating).toBe(5)
    expect(sanitizeFeedbackPayload({ rating: 3 }).rating).toBe(3)
  })

  test('rounds fractional ratings', () => {
    expect(sanitizeFeedbackPayload({ rating: 3.4 }).rating).toBe(3)
    expect(sanitizeFeedbackPayload({ rating: 3.6 }).rating).toBe(4)
  })

  test('coerces non-numeric ratings to 1 (lower clamp of NaN)', () => {
    expect(sanitizeFeedbackPayload({ rating: 'three' }).rating).toBe(1)
    expect(sanitizeFeedbackPayload({}).rating).toBe(1)
    expect(sanitizeFeedbackPayload(null).rating).toBe(1)
    expect(sanitizeFeedbackPayload(undefined).rating).toBe(1)
  })

  test('truncates comment to 1000 characters', () => {
    const long = 'x'.repeat(1500)
    const result = sanitizeFeedbackPayload({ rating: 5, comment: long })
    expect(result.comment).toHaveLength(1000)
  })

  test('non-string comment becomes empty string', () => {
    expect(sanitizeFeedbackPayload({ rating: 5, comment: 42 }).comment).toBe('')
    expect(sanitizeFeedbackPayload({ rating: 5 }).comment).toBe('')
  })

  test('preserves a short string comment as-is', () => {
    expect(sanitizeFeedbackPayload({ rating: 4, comment: 'looks great' }).comment).toBe('looks great')
  })
})
