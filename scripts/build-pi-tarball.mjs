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
const piSrc = path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')
// Forward-slash relative path for tar's -C: keeps Windows drive letters/backslashes
// out of tar args (both bsdtar and msys2 GNU tar choke on `D:\…`). See the companion
// build script's `fwd` note.
const fwd = (from, to) => path.relative(from, to).split(path.sep).join('/') || '.'

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
// Stage pi's runtime dependency closure. pi's own node_modules only holds deps
// the installer chose to nest; a hoisting package manager (bun, and npm when
// there's no version conflict) lifts the rest to the ROOT node_modules. Copying
// just pi's nested node_modules therefore misses hoisted deps — e.g. `undici`,
// which pi imports as a bare external at runtime (dist/core/http-dispatcher).
// Resolve each declared dependency from wherever Node would find it (nested,
// then up to the root) and copy it in, recursing through its own deps. Skip the
// pruned native/TUI-only packages so they (and their subtrees) never get pulled.
stageDepClosure(piSrc, stage)
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
// Basename archive + relative -C (cwd = dist) keep Windows drive letters out of
// tar's path args (both bsdtar and msys2 GNU tar read `D:\…` as a remote host).
execFileSync('tar', ['--no-xattrs', '-czf', path.basename(outTar), '-C', fwd(dist, stage), '.'], { stdio: 'inherit', cwd: dist })
console.log(`[pi] wrote ${path.relative(repoRoot, outTar)} (staged ${stagedSize} MB)`)

// --------------------------------------------------------------------------

/** Resolve a package's directory the way Node would for `require(name)` from
 *  `fromDir`: check fromDir/node_modules/name, then walk up the tree. Returns
 *  null if not installed anywhere above fromDir. */
function resolvePkgDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Copy the runtime dependency closure of the package at `pkgRoot` into
 *  `stageRoot/node_modules`, flattened. Resolution walks up from each consumer
 *  so it works whether deps are nested (npm-with-conflict) or hoisted to the
 *  root (bun). Deduped by package name — fine for a hoisted single-version tree.
 *  Native/TUI-only packages in PRUNE_DEPS are skipped along with their subtrees. */
function stageDepClosure(pkgRoot, stageRoot) {
  const isPruned = (name) => PRUNE_DEPS.some((p) => name === p || name.startsWith(`${p}/`))
  const seen = new Set()
  const missing = []
  // Seed with the root package's direct dependencies.
  const queue = Object.keys(readDeps(pkgRoot)).map((name) => ({ name, fromDir: pkgRoot }))
  while (queue.length) {
    const { name, fromDir } = queue.shift()
    if (seen.has(name) || isPruned(name)) continue
    seen.add(name)
    const src = resolvePkgDir(name, fromDir)
    if (!src) { missing.push(name); continue }
    const dest = path.join(stageRoot, 'node_modules', name)
    if (!existsSync(dest)) {
      mkdirSync(path.dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true, dereference: true })
    }
    for (const dep of Object.keys(readDeps(src))) queue.push({ name: dep, fromDir: src })
  }
  console.log(`[pi] staged dependency closure (${seen.size - missing.length} packages)`)
  if (missing.length) {
    // Optional/peer deps absent from the install are expected (e.g. the pruned
    // natives' optional peers); warn but don't fail — rpc mode doesn't load them.
    console.warn(`[pi] ${missing.length} declared dep(s) not installed, skipped: ${missing.slice(0, 12).join(', ')}`)
  }
}

/** A package's runtime `dependencies` map (empty object when none). */
function readDeps(pkgDir) {
  try {
    return JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).dependencies ?? {}
  } catch {
    return {}
  }
}

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
