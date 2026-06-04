// =============================================================================
// Build the cate-pi tarball — the pi coding agent (@earendil-works/pi-coding-agent)
// shipped to a host on demand and run by the companion (local or remote) in
// `--mode rpc`. pi is NOT bundled in the desktop app anymore; it's pulled per
// version like the companion daemon.
//
//   dist-companion/cate-pi-<piVersion>.tgz
//     dist/            (pi's built CLI — node dist/cli.js --mode rpc)
//     node_modules/    (pruned: provider SDKs kept; native + TUI-only deps cut)
//     package.json
//
// CROSS-PLATFORM: in --mode rpc pi never loads its native deps (koffi/clipboard
// are TUI-only + guarded; photon is a lazy dynamic import) — verified — so we
// drop them and ship ONE artifact for every target. pi runs under the
// companion's bundled Node, so no runtime is included here.
//
// Usage: node scripts/build-pi-tarball.mjs
// =============================================================================

import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(repoRoot, 'dist-companion')
// GNU tar (the Windows runner's tar) reads the `D:` in an absolute archive path
// as an rsh host spec ("Cannot connect to D:"). --force-local disables that. Only
// on win32: macOS/Linux use bsdtar, which rejects the flag and has no drive colon.
const FORCE_LOCAL = process.platform === 'win32' ? ['--force-local'] : []
const piSrc = path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')

if (!existsSync(piSrc)) {
  console.error('[pi] @earendil-works/pi-coding-agent not found — run `npm install` first')
  process.exit(1)
}

const piVersion = JSON.parse(readFileSync(path.join(piSrc, 'package.json'), 'utf-8')).version
syncPiVersion(piVersion)

// Native + TUI-only deps that --mode rpc never loads (keeps the artifact pure JS
// and cross-platform). koffi is FFI (only via clipboard); @mariozechner =
// clipboard native; @silvia-odwyer = photon (lazy image processing).
const PRUNE_DEPS = ['koffi', '@mariozechner', '@silvia-odwyer']

const stage = path.join(dist, 'stage', 'pi')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// Copy pi, minus the obvious bulk (docs/examples), then prune deps + maps.
cpSync(piSrc, stage, {
  recursive: true,
  dereference: true,
  filter: (src) => {
    const rel = path.relative(piSrc, src)
    return rel !== 'docs' && rel !== 'examples'
  },
})
for (const dep of PRUNE_DEPS) {
  rmSync(path.join(stage, 'node_modules', dep), { recursive: true, force: true })
}
let mapCount = 0
;(function dropMaps(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) dropMaps(p)
    else if (e.name.endsWith('.js.map') || e.name.endsWith('.d.ts.map')) { unlinkSync(p); mapCount++ }
  }
})(stage)
console.log(`[pi] pruned ${PRUNE_DEPS.join(', ')} + ${mapCount} source maps`)

// Guard the cross-platform claim: any leftover native binary means a target
// dependency slipped through and the single-artifact assumption is wrong.
const leftover = []
;(function findNative(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findNative(p)
    else if (e.name.endsWith('.node') || e.name.endsWith('.wasm')) leftover.push(path.relative(stage, p))
  }
})(stage)
if (leftover.length) {
  console.warn(`[pi] WARNING: ${leftover.length} native binaries remain (artifact may not be cross-platform):`)
  for (const f of leftover.slice(0, 10)) console.warn(`       ${f}`)
}

if (!existsSync(path.join(stage, 'dist', 'cli.js'))) {
  console.error('[pi] staged pi is missing dist/cli.js')
  process.exit(1)
}

const stagedSize = dirSizeMb(stage)
const outTar = path.join(dist, `cate-pi-${piVersion}.tgz`)
rmSync(outTar, { force: true })
// --no-xattrs: macOS provenance xattrs would make GNU tar warn on extraction.
execFileSync('tar', [...FORCE_LOCAL, '--no-xattrs', '-czf', outTar, '-C', stage, '.'], { stdio: 'inherit' })
console.log(`[pi] wrote ${path.relative(repoRoot, outTar)} (staged ${stagedSize} MB)`)

// --------------------------------------------------------------------------

/** Generate src/companion/piVersion.ts so client + daemon agree on which
 *  cate-pi tarball to pull (mirrors version.ts for the companion). */
function syncPiVersion(version) {
  const file = path.join(repoRoot, 'src/companion/piVersion.ts')
  const next =
    '// =============================================================================\n' +
    '// pi version — GENERATED from the installed @earendil-works/pi-coding-agent by\n' +
    '// `npm run pi:tarball`. The companion ships pi per this version; the host pulls\n' +
    '// cate-pi-<PI_VERSION>.tgz from the release. Do not edit by hand.\n' +
    '// =============================================================================\n\n' +
    `export const PI_VERSION = '${version}'\n`
  if (!existsSync(file) || readFileSync(file, 'utf-8') !== next) {
    writeFileSync(file, next)
    console.log(`[pi] piVersion.ts -> ${version}`)
  }
}

function dirSizeMb(dir) {
  let bytes = 0
  ;(function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else bytes += statSync(p).size
    }
  })(dir)
  return Math.round(bytes / 1e6)
}
