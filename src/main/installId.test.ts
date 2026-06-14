import { describe, expect, test, vi, beforeEach } from 'vitest'

// installId persists to disk via jsonFileStore; back it with an in-memory file
// so we can exercise the "did a valid id already exist?" capture without fs.
let store: Record<string, string> = {}
vi.mock('./jsonFileStore', () => ({
  readTextFile: (name: string) => (name in store ? store[name] : null),
  writeTextFile: (name: string, value: string) => { store[name] = value },
}))

const VALID = '12345678-1234-1234-1234-1234567890ab'

beforeEach(() => {
  store = {}
  vi.resetModules()
})

describe('installIdPreexisted', () => {
  test('false when no id file exists (a freshly generated id is written)', async () => {
    const { getInstallId, installIdPreexisted } = await import('./installId')
    expect(installIdPreexisted()).toBe(false)
    // The generated id is now persisted for subsequent sessions.
    expect(getInstallId()).toMatch(/^[0-9a-f-]{36}$/i)
  })

  test('true when a valid id file already exists on first access', async () => {
    store['install-id'] = VALID
    const { getInstallId, installIdPreexisted } = await import('./installId')
    expect(installIdPreexisted()).toBe(true)
    expect(getInstallId()).toBe(VALID)
  })

  test('a malformed stored id counts as not pre-existing and is replaced', async () => {
    store['install-id'] = 'not-a-uuid'
    const { getInstallId, installIdPreexisted } = await import('./installId')
    expect(installIdPreexisted()).toBe(false)
    expect(getInstallId()).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
