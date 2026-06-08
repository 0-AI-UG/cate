// =============================================================================
// Interop regression guard for `assertSupportedPrivateKey` — issue #335.
//
// The bug: `sshKey.ts` reached ssh2's parser via `mod.utils.parseKey`. ssh2 is
// CommonJS and `utils` is NOT a statically-detectable named export, so under
// Node's native ESM↔CJS interop (the PACKAGED app) `mod.utils` is `undefined`
// and every real key threw `Cannot read properties of undefined (reading
// 'parseKey')`. The unit suite (sshKey.test.ts) stayed green because vitest's
// own loader hoists `utils`, so it can NEVER reproduce this — no matter the file
// name or environment knob.
//
// The only faithful reproduction is a real child `node` process importing the
// compiled module through native interop. We transpile the REAL sshKey.ts with
// esbuild, run it under plain Node, and assert a freshly generated key is
// accepted. To prove the test actually exercises the regression path, we also
// run a variant with the `mod.default?.utils` fallback neutered and assert it
// still throws the original TypeError.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { transformSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

// Compile the real source to ESM. The `await import('ssh2')` is indirected
// through a variable, so esbuild leaves it as a runtime import resolved against
// the project's node_modules — i.e. the exact module ssh2 ships.
const compiled = transformSync(readFileSync(join(here, 'sshKey.ts'), 'utf8'), {
  loader: 'ts',
  format: 'esm',
}).code

// The child generates a real key, calls the REAL validator, and reports the raw
// interop shape so a failure tells us whether the env or the code regressed.
const RUNNER = `
import { assertSupportedPrivateKey } from './sshKey.mjs'
import { generateKeyPairSync } from 'node:crypto'

const mod = await import('ssh2')
const raw = { utils: typeof mod.utils, defaultParseKey: typeof mod.default?.utils?.parseKey }

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

let accepted = false
await assertSupportedPrivateKey(Buffer.from(privateKey))
accepted = true

let formatErr = ''
try {
  await assertSupportedPrivateKey(Buffer.from('not a key at all'))
} catch (e) {
  formatErr = e.message
}

console.log(JSON.stringify({ raw, accepted, formatErr }))
`

/**
 * Write `module` + runner into a throwaway dir UNDER the repo (so the child's
 * `import('ssh2')` resolves against the project's node_modules) and run it in a
 * real Node process. Returns the child's stdout, or throws with its stderr.
 */
function runInNode(moduleSource: string): string {
  const cacheRoot = join(repoRoot, 'node_modules', '.cache')
  mkdirSync(cacheRoot, { recursive: true })
  const dir = mkdtempSync(join(cacheRoot, 'sshKey-interop-'))
  try {
    writeFileSync(join(dir, 'sshKey.mjs'), moduleSource)
    writeFileSync(join(dir, 'run.mjs'), RUNNER)
    // stderr → pipe (not inherit) so an expected broken-variant crash doesn't
    // dump a stack trace into the test logs; it's still captured on the thrown
    // error's `.stderr` for assertions.
    return execFileSync(process.execPath, ['run.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('assertSupportedPrivateKey under native Node ESM↔CJS interop (#335)', () => {
  it('accepts a real key through the same module shape the packaged app sees', () => {
    const out = runInNode(compiled)
    const result = JSON.parse(out.trim())

    // The condition that makes the unit suite blind: ssh2's `utils` is absent as
    // a top-level export, only `default.utils` carries the parser. If this ever
    // flips, this guard is moot and should be revisited.
    expect(result.raw.utils).toBe('undefined')
    expect(result.raw.defaultParseKey).toBe('function')

    // The field crash: a valid key must be accepted, not throw on `.parseKey`.
    expect(result.accepted).toBe(true)
    // Format detection still runs on the real parser.
    expect(result.formatErr).toMatch(/Unsupported private key format/)
  })

  it('would fail without the default.utils fallback (proves this test catches the regression)', () => {
    // Sentinel guard: if the fix is refactored away from this expression the
    // simulation is no longer meaningful — fail loudly instead of silently.
    expect(compiled).toContain('mod.default?.utils')

    const broken = compiled.replace('mod.default?.utils', 'undefined')
    expect(() => runInNode(broken)).toThrow(/Cannot read properties of undefined \(reading 'parseKey'\)/)
  })
})
