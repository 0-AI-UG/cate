// Bundle the standalone Cate runtime daemon for local development and release
// packaging. Native dependencies stay external because runtime tarballs supply
// target-specific builds alongside this portable CommonJS bundle.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

export function syncRuntimeVersion() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
  const versionFile = path.join(repoRoot, 'src/runtime/version.ts')
  const header =
    '// =============================================================================\n' +
    '// Runtime version \u2014 GENERATED from package.json by `npm run build:runtime`.\n' +
    '// Do not edit by hand. The client embeds the version it expects and the daemon\n' +
    '// reports the version it is; a mismatch triggers auto-upgrade (re-push). It is\n' +
    '// kept equal to the app version so the release tag `v<version>` hosts the\n' +
    '// matching runtime tarballs (see runtimeArtifacts.ts).\n' +
    '// =============================================================================\n\n'
  const body = `export const RUNTIME_VERSION = '${pkg.version}'\n`
  const next = header + body
  if (readFileSync(versionFile, 'utf-8') !== next) {
    writeFileSync(versionFile, next)
    console.log(`[build:runtime] version.ts -> ${pkg.version}`)
  }
  return pkg.version
}

export const runtimeBuildOptions = {
  entryPoints: [path.join(repoRoot, 'src/runtime/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(repoRoot, 'dist-runtime/runtime.cjs'),
  external: ['fsevents', 'node-pty', '@parcel/watcher', 'electron'],
  logLevel: 'info',
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncRuntimeVersion()
  await build(runtimeBuildOptions)
}
