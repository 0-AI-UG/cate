// Bundle the standalone Cate runtime daemon for local development and release
// packaging. Native dependencies stay external because runtime tarballs supply
// target-specific builds alongside this portable split module graph.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { computeBuildId } from './build-id.mjs'

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
  format: 'esm',
  splitting: true,
  target: 'node20',
  outdir: path.join(repoRoot, 'dist-runtime/runtime-modules'),
  entryNames: 'main',
  chunkNames: '[name]-[hash]',
  outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as __cateCreateRequire } from 'node:module'; const require = __cateCreateRequire(import.meta.url);" },
  metafile: true,
  external: ['fsevents', 'node-pty', '@parcel/watcher', 'electron', 'node-datachannel'],
  // Sent in `hello` to identify the install for runtime updates.
  // A release bundle prunes unused installs; a checkout's leaves them alone.
  define: {
    __CATE_BUILD__: JSON.stringify(computeBuildId(repoRoot)),
    __CATE_RELEASE__: JSON.stringify(process.env.CATE_RELEASE === '1'),
  },
  logLevel: 'info',
}

// Keep the public CJS launch path, but let Node load optional services as
// separate modules. A CJS dynamic import inside one bundle still retains all
// of the source in every daemon.
export async function buildRuntime(outfile = path.join(repoRoot, 'dist-runtime/runtime.cjs')) {
  const modules = path.join(path.dirname(outfile), 'runtime-modules')
  // A running development daemon may still import a previous build's hashed
  // chunks. Keep those files until dist-runtime is explicitly cleaned; release
  // staging copies only the outputs listed in this build's metafile.
  mkdirSync(modules, { recursive: true })
  const result = await build({ ...runtimeBuildOptions, outdir: modules })
  writeFileSync(outfile, "// Cate runtime launcher; modules ship beside this file.\nimport('./runtime-modules/main.mjs').catch(error => { console.error(error); process.exitCode = 1 });\n")
  return result.metafile
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncRuntimeVersion()
  await buildRuntime()
}
