import { describe, expect, test } from 'vitest'
import { codexTrustedHash } from './codexTrust'

describe('codex trusted hash', () => {
  test('pinned vector — the exact builder verified live against codex', () => {
    // If this drifts, the live contract suite is the authority; both must move
    // together with a codex release that changes the trust scheme.
    expect(codexTrustedHash('session_start', '/cate/hooks/bridge-codex', 60)).toBe(
      'sha256:45b23f6911ff81a78ed16f786e7ff25cad505d52d656cab9b3236565677d2c37',
    )
  })
})
