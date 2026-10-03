// The build id baked into the daemon bundle and the desktop app as
// `__CATE_BUILD__`: the package version plus a hash of the source tree. Both
// sides compute it from the same files, so a client refuses a runtime built
// from other sources (a stale daemon) even when the versions are equal.
// Shell code (src/shells, apart from settings slices) is not in the runtime
// and is left out.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Tests and the generated version file do not change what ships. */
const SKIP = /\.(test|itest)\.tsx?$|\.test-helpers\.ts$|[/\\]runtime[/\\]daemon[/\\]contract[/\\]version\.ts$/
/** Shells are not in the runtime, so a shell-only change keeps the build.
 *  Their settings slices are: kernel/settings composes them. */
const SHELL = /^shells[/\\]/
const SETTINGS_SLICE = /[/\\]contract[/\\]settings\.ts$/

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(file)
      return entry.isFile() && !SKIP.test(file) ? [file] : []
    })
}

export function computeBuildId(repoRoot) {
  const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
  const src = path.join(repoRoot, 'src')
  const hash = createHash('sha256')
  for (const file of sourceFiles(src)) {
    const rel = path.relative(src, file)
    if (SHELL.test(rel) && !SETTINGS_SLICE.test(rel)) continue
    hash.update(rel.split(path.sep).join('/'))
    hash.update('\0')
    // CRLF checkouts (Windows CI) must hash like LF ones.
    hash.update(readFileSync(file, 'utf-8').replace(/\r\n/g, '\n'))
    hash.update('\0')
  }
  return `${version}+${hash.digest('hex').slice(0, 12)}`
}
