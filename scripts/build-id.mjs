// The build id baked into the daemon bundle and the desktop app as
// `__CATE_BUILD__`: the package version plus a hash of everything the runtime
// install is made from: the source tree, the bundled skills, the T3 patches
// and the lockfile. Both sides compute it from the same files, so a client
// refuses a runtime built from other inputs (a stale daemon) even when the
// versions are equal. Shell code (src/shells, apart from settings slices) is
// not in the runtime and is left out.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

/** The T3 patch scripts the install applies. */
const T3_PATCH = /^patch-t3[^/\\]*\.mjs$/

export function computeBuildId(repoRoot) {
  const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
  const hash = createHash('sha256')
  const add = (file) => {
    hash.update(path.relative(repoRoot, file).split(path.sep).join('/'))
    hash.update('\0')
    // CRLF checkouts (Windows CI) must hash like LF ones.
    hash.update(readFileSync(file, 'utf-8').replace(/\r\n/g, '\n'))
    hash.update('\0')
  }
  const src = path.join(repoRoot, 'src')
  for (const file of sourceFiles(src)) {
    const rel = path.relative(src, file)
    if (SHELL.test(rel) && !SETTINGS_SLICE.test(rel)) continue
    add(file)
  }
  const skills = path.join(repoRoot, 'skills')
  if (existsSync(skills)) for (const file of sourceFiles(skills)) add(file)
  const scripts = path.join(repoRoot, 'scripts')
  if (existsSync(scripts)) {
    for (const file of sourceFiles(scripts)) if (T3_PATCH.test(path.basename(file)) && !/\.test\.mjs$/.test(file)) add(file)
  }
  const lock = path.join(repoRoot, 'package-lock.json')
  if (existsSync(lock)) add(lock)
  return `${version}+${hash.digest('hex').slice(0, 12)}`
}
