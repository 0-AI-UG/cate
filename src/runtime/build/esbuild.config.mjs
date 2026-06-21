// =============================================================================
// Bundles the cate-runtime daemon into a single runtime-agnostic .cjs that
// can be shipped to a server / WSL and run by a plain Node (NOT Electron). Run
// via `npm run build:runtime`.
//
// `simple-git` and `chokidar` are bundled inline so the artifact is
// self-contained; `fsevents` (chokidar's optional macOS native dep) is
// externalized — on the Linux/WSL target it isn't present, and chokidar falls
// back to fs.watch. `node-pty` and `@parcel/watcher` are externalized native
// modules: terminals (ProcessHost) and workspace-tree watching need the
// per-target prebuilt .node binary staged alongside the bundle (see
// build-runtime-tarball.mjs's stageNodePty / stageParcelWatcher). @parcel/watcher
// also resolves its platform binary via a computed `require()`, which can't be
// bundled — another reason it must stay external.
//
// NOTE: this produces the JS bundle only. Shipping a real daemon also needs the
// per-OS/arch node-pty prebuild staged next to it and, optionally, a bundled
// Node runtime — see docs/remote-workspaces (build pipeline section).
// =============================================================================

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

// Regenerate version.ts from package.json so the shipped client, its bundled
// daemon, and the GitHub release tag (`v<version>`) always agree — the daemon
// download URL and the handshake version-check both derive from this.
export function syncRuntimeVersion() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
  const versionFile = path.join(repoRoot, 'src/runtime/version.ts')
  const header =
    '// =============================================================================\n' +
    '// Runtime version — GENERATED from package.json by `npm run build:runtime`.\n' +
    '// Do not edit by hand. The client embeds the version it expects and the daemon\n' +
    '// reports the version it is; a mismatch triggers auto-upgrade (re-push). It is\n' +
    '// kept equal to the app version so the release tag `v<version>` hosts the\n' +
    "// matching runtime tarballs (see runtimeArtifacts.ts).\n" +
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

// Run directly (npm script) — guarded so importing this module (tests) doesn't build.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncRuntimeVersion()
  await build(runtimeBuildOptions)
}
