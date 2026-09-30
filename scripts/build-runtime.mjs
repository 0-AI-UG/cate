// Bundle the standalone Cate runtime daemon for local development and release
// packaging. Native dependencies stay external because runtime tarballs supply
// target-specific builds alongside this portable CommonJS bundle.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

// The daemon reports RUNTIME_VERSION in `hello`; it is kept equal to the app
// version so the release tag `v<version>` hosts the matching tarballs.
const VERSION_FILES = {
  'src/runtime/daemon/contract/version.ts':
    '// GENERATED from package.json by `npm run build:runtime`. Do not edit by hand.\n' +
    '// Kept equal to the app version so the release tag `v<version>` hosts the\n' +
    '// matching runtime tarballs.\n\n',
}

export function syncRuntimeVersion() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
  const body = `export const RUNTIME_VERSION = '${pkg.version}'\n`
  for (const [rel, header] of Object.entries(VERSION_FILES)) {
    const file = path.join(repoRoot, rel)
    if (!existsSync(file)) continue
    const next = header + body
    if (readFileSync(file, 'utf-8') !== next) {
      writeFileSync(file, next)
      console.log(`[build:runtime] ${rel} -> ${pkg.version}`)
    }
  }
  return pkg.version
}

export const runtimeBuildOptions = {
  entryPoints: [path.join(repoRoot, 'src/runtime/daemon/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(repoRoot, 'dist-runtime/runtime.cjs'),
  external: ['fsevents', 'node-pty', '@parcel/watcher', 'electron', 'node-datachannel'],
  logLevel: 'info',
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncRuntimeVersion()
  await build(runtimeBuildOptions)
}
