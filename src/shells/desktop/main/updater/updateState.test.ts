import { describe, it, expect } from 'vitest'
import {
  decideInstallState,
  normalizeUpdateRecord,
  DEFAULT_UPDATE_RECORD,
  MAX_INSTALL_ATTEMPTS,
  type UpdateRecord,
} from './updateState'

describe('decideInstallState', () => {
  it('returns "none" when no update is pending', () => {
    const d = decideInstallState({ pendingVersion: null, attempts: 0 }, '1.2.2')
    expect(d.kind).toBe('none')
    expect(d.nextRecord).toEqual(DEFAULT_UPDATE_RECORD)
  })

  it('returns "succeeded" and clears the record when current === pending', () => {
    const d = decideInstallState({ pendingVersion: '1.2.3', attempts: 0 }, '1.2.3')
    expect(d.kind).toBe('succeeded')
    expect(d.nextRecord).toEqual({ pendingVersion: null, attempts: 0 })
  })

  it('treats current NEWER than pending as success (user jumped ahead)', () => {
    const d = decideInstallState({ pendingVersion: '1.2.3', attempts: 1 }, '1.2.4')
    expect(d.kind).toBe('succeeded')
    expect(d.nextRecord).toEqual({ pendingVersion: null, attempts: 0 })
  })

  it('returns "retry" and increments attempts on the first failed install', () => {
    const d = decideInstallState({ pendingVersion: '1.2.3', attempts: 0 }, '1.2.2')
    expect(d.kind).toBe('retry')
    expect(d.nextRecord).toEqual({ pendingVersion: '1.2.3', attempts: 1 })
  })

  it('returns "give-up-manual" once failed attempts reach the cap', () => {
    const d = decideInstallState({ pendingVersion: '1.2.3', attempts: 1 }, '1.2.2')
    expect(d.kind).toBe('give-up-manual')
    expect(d.nextRecord).toEqual({ pendingVersion: '1.2.3', attempts: MAX_INSTALL_ATTEMPTS })
  })

  it('stays "give-up-manual" on subsequent launches without resetting', () => {
    const d = decideInstallState({ pendingVersion: '1.2.3', attempts: MAX_INSTALL_ATTEMPTS }, '1.2.2')
    expect(d.kind).toBe('give-up-manual')
    expect(d.nextRecord).toEqual({ pendingVersion: '1.2.3', attempts: MAX_INSTALL_ATTEMPTS })
  })
})

describe('normalizeUpdateRecord', () => {
  it('falls back to defaults for non-object / null input', () => {
    expect(normalizeUpdateRecord(null, DEFAULT_UPDATE_RECORD)).toEqual(DEFAULT_UPDATE_RECORD)
    expect(normalizeUpdateRecord('nope', DEFAULT_UPDATE_RECORD)).toEqual(DEFAULT_UPDATE_RECORD)
    expect(normalizeUpdateRecord(42, DEFAULT_UPDATE_RECORD)).toEqual(DEFAULT_UPDATE_RECORD)
  })

  it('keeps a valid record', () => {
    const rec: UpdateRecord = { pendingVersion: '1.2.3', attempts: 1 }
    expect(normalizeUpdateRecord(rec, DEFAULT_UPDATE_RECORD)).toEqual(rec)
  })

  it('coerces a bad pendingVersion to null and clamps attempts to a non-negative int', () => {
    expect(normalizeUpdateRecord({ pendingVersion: 123, attempts: -5 }, DEFAULT_UPDATE_RECORD)).toEqual({
      pendingVersion: null,
      attempts: 0,
    })
    expect(normalizeUpdateRecord({ pendingVersion: '1.2.3', attempts: 2.7 }, DEFAULT_UPDATE_RECORD)).toEqual({
      pendingVersion: '1.2.3',
      attempts: 2,
    })
  })
})
