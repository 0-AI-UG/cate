import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

for (const name of ['mac', 'runtime']) {
  const relative = `build/entitlements.${name}.plist`
  describe(relative, () => {
    it('ships in a clean checkout for release signing', () => {
      expect(execFileSync('git', ['ls-files', '--error-unmatch', relative], { cwd: root, encoding: 'utf8' }).trim()).toBe(relative)
    })

    it.skipIf(process.platform !== 'darwin')('is accepted by codesign with hardened runtime', () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'cate-signing-test-'))
      try {
        const binary = path.join(directory, 'true')
        copyFileSync('/usr/bin/true', binary)
        execFileSync('plutil', ['-lint', path.join(root, relative)])
        execFileSync('codesign', ['--force', '--timestamp=none', '--options', 'runtime', '--entitlements', path.join(root, relative), '--sign', '-', binary])
        execFileSync('codesign', ['--verify', '--strict', binary])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })
}
