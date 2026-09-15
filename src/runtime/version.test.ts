import { describe, expect, test } from 'vitest'
import packageJson from '../../package.json'
import { RUNTIME_VERSION } from './version'

describe('runtime version', () => {
  test('matches the application package version', () => {
    expect(RUNTIME_VERSION).toBe(packageJson.version)
  })
})
