// =============================================================================
// Build ONE self-contained cate-runtime tarball for a single target:
//
//   dist-runtime/cate-runtime-<version>-<target>.tgz
//     runtime.cjs                       (esbuild bundle, runtime-agnostic)
//     node_modules/node-pty/...           (with prebuilds/<target>/pty.node
//                                          + spawn-helper)
//     node_modules/@parcel/watcher/...     (+ @parcel/watcher-<target>/watcher.node
//                                          — workspace-tree file watching)
//     runtime/bin/node[.exe]              (bundled Node runtime for the target)
//     runtime/bin/rg[.exe]                 (bundled ripgrep for content search)
//     pi/dist/cli.js                       (bundled pi coding agent, cross-platform)
//
// UNIFIED layout: every target keeps node + rg under runtime/bin/, just with a
// `.exe` suffix on win32 (runtime/bin/node.exe, runtime/bin/rg.exe). The install
// dir depth is identical everywhere (process.execPath = runtime/bin/node[.exe]),
// so the daemon's resolvers only branch on the FILENAME, never the directory.
//
// node-pty resolves its native binary from prebuilds/<platform>-<arch>/ (see
// node-pty/lib/utils.js), and the npm package ships NO linux prebuild — so we
// stage the binary there ourselves, compiled for the target. On win32 node-pty's
// conpty backend needs several native files (pty.node + conpty*.node + winpty.dll
// + the conpty/ helper dir); we stage those from the host's installed node-pty.
//
// Usage:
//   node scripts/build-runtime-tarball.mjs                 # host target
//   node scripts/build-runtime-tarball.mjs --target linux-x64
//   node scripts/build-runtime-tarball.mjs --target linux-x64 --docker
//
// On CI, run this NATIVELY on the matching runner (ubuntu for linux-*, macos
// for darwin-*) so node-pty's binary is the runner's own compiled output. The
// --docker flag cross-builds the linux node-pty binary on a non-linux host
// (e.g. a Mac) for local end-to-end testing before CI exists.
// =============================================================================

import { existsSync, mkdirSync, cpSync, rmSync, chmodSync, readFileSync, renameSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runtimeBuildOptions, syncRuntimeVersion } from '../src/runtime/build/esbuild.config.mjs'

// Bundled runtime version. MUST satisfy pi's `engines.node` (currently
// >=22.19.0 — its undici build calls webidl APIs absent on Node 20, which
// crashes pi on launch under an older runtime). Keep on a 22.x LTS line.
const NODE_VERSION = '22.19.0'
const NODE_PTY_VERSION = '1.1.0' // must match package.json
// ripgrep for the daemon's content search. Prebuilt static binaries from the
// upstream GitHub release (no CI build needed) — fetched like the node runtime.
const RIPGREP_VERSION = '14.1.1'
// target → ripgrep release triple. linux-x64 uses the static musl build (runs on
// any glibc/musl host); the others match the node runtime's libc/abi.
const RIPGREP_TRIPLES = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  // Windows ripgrep ships as a .zip containing rg.exe (handled in stageRipgrep).
  'win32-x64': 'x86_64-pc-windows-msvc',
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(repoRoot, 'dist-runtime')

// tar invocations must avoid Windows drive letters and backslashes: a `D:`-prefixed
// path reads as a remote `host:path` spec on BOTH the Windows runner's System32
// bsdtar (default-shell steps) and Git's msys2 GNU tar (shell: bash steps), and
// msys2 tar also can't chdir into a backslashed path. So we run tar with `cwd` set
// and pass the archive as a basename + the -C dir as a forward-slash relative path.
const fwd = (from, to) => path.relative(from, to).split(path.sep).join('/') || '.'

const args = process.argv.slice(2)
const useDocker = args.includes('--docker')
const targetArg = valueOf('--target') ?? `${plat(process.platform)}-${process.arch}`
const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']
if (!SUPPORTED.includes(targetArg)) {
  console.error(`[runtime] unsupported target "${targetArg}". One of: ${SUPPORTED.join(', ')}`)
  process.exit(1)
}
const [targetPlatform, targetArch] = targetArg.split('-')

const version = await buildBundle()
const stageDir = path.join(dist, 'stage', targetArg)
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })

// Delete the previous tarball UP FRONT (before staging), not just before the
// tar below. A staging step that throws partway (e.g. a ripgrep download
// failure) used to exit here leaving the OLD .tgz in place — a misleading
// "valid but incomplete" artifact (it shipped with no rg/pi, so the dev
// isInstalled probe failed forever → reinstall on every connect). Now an
// aborted build leaves no tarball at all.
const exe = targetPlatform === 'win32' ? '.exe' : ''
const outTar = path.join(dist, `cate-runtime-${version}-${targetArg}.tgz`)
rmSync(outTar, { force: true })

// Unified runtime/bin/ layout; only the filename gains a `.exe` on win32 so the
// install-dir depth (and thus the resolvers) stay identical across platforms.
cpSync(path.join(dist, 'runtime.cjs'), path.join(stageDir, 'runtime.cjs'))
await stageNodePty(stageDir)
await stageParcelWatcher(stageDir)
await stageNodeRuntime(targetPlatform, targetArch, path.join(stageDir, 'runtime', 'bin', `node${exe}`))
await stageRipgrep(targetArg, path.join(stageDir, 'runtime', 'bin', `rg${exe}`))
stagePi(path.join(stageDir, 'pi'))
signMacNatives(stageDir)

// Fail loudly if anything the daemon's install-probe requires is missing, rather
// than shipping a tarball that extracts but never satisfies isInstalled (every
// connect would then re-push it). These are the exact paths sshTransport's
// dev-mode isInstalled checks.
const required = [
  `runtime.cjs`,
  path.join('runtime', 'bin', `node${exe}`),
  path.join('runtime', 'bin', `rg${exe}`),
  path.join('pi', 'dist', 'cli.js'),
]
const missing = required.filter((rel) => !existsSync(path.join(stageDir, rel)))
if (missing.length) throw new Error(`[runtime] incomplete stage for ${targetArg}; missing: ${missing.join(', ')}`)

// --no-xattrs: don't archive extended attributes (macOS keeps re-stamping a
// com.apple.provenance xattr that otherwise makes GNU tar warn on extraction
// on the Ubuntu server). Supported by both bsdtar and GNU tar. Basename + relative
// -C (cwd = dist) keep Windows drive letters out of tar's path args — see `fwd`.
//
// Write to a temp file then atomically rename into place. The app extracts this
// exact tarball (dist-runtime/) for the LOCAL runtime, so a rebuild while
// Cate is running must never expose a half-written archive — a reader that
// caught `tar -czf` mid-stream would hit "truncated gzip input" and cache a
// corrupt install. rename(2) within the same dir is atomic.
const tmpTar = `${path.basename(outTar)}.partial`
execFileSync('tar', ['--no-xattrs', '-czf', tmpTar, '-C', fwd(dist, stageDir), '.'], { stdio: 'inherit', cwd: dist })
renameSync(path.join(dist, tmpTar), outTar)
console.log(`[runtime] wrote ${path.relative(repoRoot, outTar)}`)

// --------------------------------------------------------------------------

async function buildBundle() {
  const v = syncRuntimeVersion()
  await build(runtimeBuildOptions)
  if (!existsSync(path.join(dist, 'runtime.cjs'))) throw new Error('esbuild did not produce runtime.cjs')
  return v
}

/** Stage node-pty with only the target's native binary under prebuilds/<target>/. */
async function stageNodePty(outRoot) {
  const src = path.join(repoRoot, 'node_modules', 'node-pty')
  if (!existsSync(src)) throw new Error('node-pty not found in node_modules — run `npm install` first')
  const dest = path.join(outRoot, 'node_modules', 'node-pty')
  // Copy only the runtime essentials (no C++ sources, build dir, or other-arch
  // prebuilds); the target's native binary is written under prebuilds/ below.
  mkdirSync(dest, { recursive: true })
  cpSync(path.join(src, 'lib'), path.join(dest, 'lib'), { recursive: true, dereference: true })
  cpSync(path.join(src, 'package.json'), path.join(dest, 'package.json'))

  const pbDir = path.join(dest, 'prebuilds', targetArg)
  mkdirSync(pbDir, { recursive: true })

  if (targetPlatform === 'win32') {
    // Windows: node-pty's conpty backend needs several native files, not just
    // pty.node. loadNativeModule() pulls pty.node + conpty.node +
    // conpty_console_list.node from prebuilds/win32-x64/, and the conpty/winpty
    // agents need their .dll/.exe siblings (winpty.dll, winpty-agent.exe, and the
    // conpty/ helper dir with OpenConsole.exe + conpty.dll). We copy the whole
    // prebuild dir (minus .pdb debug symbols) from the host's installed node-pty.
    const winPrebuild = await resolveWinNodePtyPrebuild()
    cpSync(winPrebuild, pbDir, {
      recursive: true,
      dereference: true,
      filter: (s) => !s.endsWith('.pdb'),
    })
    assertWinConptyStaged(pbDir, winPrebuild)
    console.log(`[runtime] staged node-pty win32 conpty native for ${targetArg}`)
    return
  }

  const { ptyNode, spawnHelper } = await resolveNativeBinaries()
  cpSync(ptyNode, path.join(pbDir, 'pty.node'))
  chmodSync(path.join(pbDir, 'pty.node'), 0o755)
  if (spawnHelper) {
    cpSync(spawnHelper, path.join(pbDir, 'spawn-helper'))
    chmodSync(path.join(pbDir, 'spawn-helper'), 0o755)
  }
  console.log(`[runtime] staged node-pty native for ${targetArg}`)
}

/** The @parcel/watcher platform-binary package dir name for a target. parcel
 *  resolves `@parcel/watcher-<platform>-<arch>` at runtime (plus a `-glibc`
 *  suffix on linux — the daemon's bundled node is an official glibc build). */
function parcelBinaryDir(platform, arch) {
  return `watcher-${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`
}

/**
 * Stage @parcel/watcher (workspace-tree watching) into the daemon's node_modules:
 * its runtime JS + dependency closure, plus the TARGET's prebuilt native package.
 *
 * @parcel/watcher is N-API (one prebuilt per platform/arch runs under any node
 * ABI, so no electron-rebuild / from-source compile — unlike node-pty). At
 * runtime its index.js does `require('@parcel/watcher-<platform>-<arch>[-glibc]')`
 * and wrapper.js pulls picomatch/is-glob; index.js pulls detect-libc on linux. We
 * stage exactly that closure. For a cross-target build (e.g. linux-arm64 on an
 * x64 host) the host's npm install only has the host's binary package, so we
 * `npm pack` the target's prebuilt package from the registry.
 */
async function stageParcelWatcher(outRoot) {
  const src = path.join(repoRoot, 'node_modules', '@parcel', 'watcher')
  if (!existsSync(src)) throw new Error('@parcel/watcher not found in node_modules — run `npm install` first')
  const version = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf-8')).version

  const nm = path.join(outRoot, 'node_modules')
  const dest = path.join(nm, '@parcel', 'watcher')
  mkdirSync(dest, { recursive: true })
  // Runtime JS only (skip src/, binding.gyp, scripts/ — build-from-source inputs).
  for (const f of ['index.js', 'wrapper.js', 'index.js.flow', 'index.d.ts', 'package.json']) {
    if (existsSync(path.join(src, f))) cpSync(path.join(src, f), path.join(dest, f))
  }
  // Stage @parcel/watcher's JS dependency closure. wrapper.js requires
  // picomatch + is-glob (→ is-extglob); index.js requires detect-libc on linux.
  // Resolve EACH from @parcel/watcher's own resolution root rather than assuming
  // a fixed location: npm may nest a dep under @parcel/watcher/node_modules (a
  // version-pin conflict) OR hoist it to the top-level node_modules (no conflict)
  // — and which one happens varies by the full install tree. A previous version
  // copied the nested dir if present, else a hardcoded list that OMITTED
  // picomatch; when npm hoisted picomatch the nested dir was absent AND it wasn't
  // in the list, so it shipped missing and the daemon crashed at startup with
  // `Cannot find module 'picomatch'` (require'd by wrapper.js). createRequire
  // finds the exact copy node would load, at whatever depth, every time.
  const requireFrom = createRequire(path.join(src, 'package.json'))
  for (const dep of ['picomatch', 'is-glob', 'is-extglob', 'detect-libc']) {
    let pkgDir
    try {
      pkgDir = path.dirname(requireFrom.resolve(`${dep}/package.json`))
    } catch {
      // detect-libc is only require'd on linux; on darwin/win it may be absent.
      if (dep === 'detect-libc') continue
      throw new Error(`@parcel/watcher dependency "${dep}" not resolvable from ${src} — run \`npm install\` first`)
    }
    // Stage into the SAME relative location node resolved it from (nested under
    // @parcel/watcher or hoisted to the top level) so resolution matches at runtime.
    const rel = path.relative(repoRoot, pkgDir)
    cpSync(pkgDir, path.join(outRoot, rel), { recursive: true, dereference: true })
  }
  // Fail loudly if the staged tree can't resolve wrapper.js's requires — the exact
  // crash that shipped before. Mirrors the watcher.node assert below.
  const stagedRequire = createRequire(path.join(dest, 'wrapper.js'))
  for (const dep of ['picomatch', 'is-glob']) {
    try {
      stagedRequire.resolve(dep)
    } catch {
      throw new Error(
        `staged @parcel/watcher cannot resolve "${dep}" from ${path.join(dest, 'wrapper.js')}. ` +
          'The daemon would crash at startup (MODULE_NOT_FOUND) — aborting the build.',
      )
    }
  }

  // The target's prebuilt native package.
  const binDir = parcelBinaryDir(targetPlatform, targetArch)
  const pkgName = `@parcel/${binDir}`
  const outBinPkg = path.join(nm, '@parcel', binDir)
  const hostTarget = `${plat(process.platform)}-${process.arch}`
  const hostBin = path.join(repoRoot, 'node_modules', '@parcel', binDir)

  if (targetArg === hostTarget && existsSync(hostBin)) {
    cpSync(hostBin, outBinPkg, { recursive: true, dereference: true })
  } else {
    // Cross-target (e.g. linux-arm64 built on x64): the host install lacks this
    // package, so pull the prebuilt from the registry. N-API → no compile needed.
    await npmPackInto(`${pkgName}@${version}`, outBinPkg)
  }

  const watcherNode = path.join(outBinPkg, 'watcher.node')
  if (!existsSync(watcherNode)) {
    throw new Error(
      `staged @parcel/watcher is missing ${pkgName}/watcher.node for ${targetArg} ` +
        `(expected at ${watcherNode}). The daemon cannot watch files without it.`,
    )
  }
  chmodSync(watcherNode, 0o755)
  console.log(`[runtime] staged @parcel/watcher ${version} (${pkgName}) for ${targetArg}`)
}

/** `npm pack <spec>` into a temp dir and extract the package's contents into
 *  `destDir` (npm tarballs nest everything under `package/`). */
async function npmPackInto(spec, destDir) {
  const tmp = path.join(os.tmpdir(), `cate-npmpack-${spec.replace(/[@/]/g, '_')}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  console.log(`[runtime] npm pack ${spec} (cross-target prebuilt)…`)
  const out = execFileSync('npm', ['pack', spec, '--silent'], { cwd: tmp, encoding: 'utf-8' })
  const tgz = out.trim().split('\n').pop().trim()
  execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'ignore', cwd: tmp })
  mkdirSync(destDir, { recursive: true })
  cpSync(path.join(tmp, 'package'), destDir, { recursive: true, dereference: true })
  rmSync(tmp, { recursive: true, force: true })
}

/**
 * Fail loudly if the staged win32 prebuild dir is missing a file node-pty's win
 * loader actually pulls in — otherwise we'd ship a daemon that can't spawn a PTY
 * (a runtime "Failed to load native module" crash instead of a build-time error).
 *
 * Required (require()'d by node-pty/lib on win32):
 *   - pty.node                 (winpty fallback module; windowsPtyAgent.js)
 *   - conpty.node              (primary conpty backend;  windowsPtyAgent.js)
 *   - conpty_console_list.node (process list agent;      conpty_console_list_agent.js)
 *   - conpty/                  (helper dir: OpenConsole.exe + conpty.dll, loaded
 *                               at runtime by the conpty backend)
 * Optional (winpty fallback, only used on pre-1809 Windows where conpty is
 * unavailable) — warn but don't fail, since conpty is primary on modern Windows:
 *   - winpty.dll, winpty-agent.exe
 */
function assertWinConptyStaged(pbDir, fromDir) {
  const required = ['pty.node', 'conpty.node', 'conpty_console_list.node', 'conpty']
  const missing = required.filter((f) => !existsSync(path.join(pbDir, f)))
  if (missing.length) {
    throw new Error(
      `staged win32 node-pty is missing required conpty file(s): ${missing.join(', ')} ` +
        `(staged into ${pbDir} from ${fromDir}). node-pty cannot spawn a PTY without these.`,
    )
  }
  const optional = ['winpty.dll', 'winpty-agent.exe']
  const missingOpt = optional.filter((f) => !existsSync(path.join(pbDir, f)))
  if (missingOpt.length) {
    console.warn(
      `[runtime] WARNING: staged win32 node-pty missing winpty fallback file(s): ` +
        `${missingOpt.join(', ')}. conpty is primary on modern Windows, but pre-1809 ` +
        `Windows would have no PTY backend.`,
    )
  }
}

/** Locate the host's win32-x64 node-pty prebuild directory (pty.node + conpty*
 *  + winpty.dll + conpty/). A win32-x64 tarball is only producible on a win32
 *  host — there is no docker cross-build for Windows. The npm node-pty package
 *  ships a ready-made prebuilds/win32-x64/ dir; a from-source build instead
 *  populates build/Release. Prefer build/Release (the host's own compiled
 *  output) and fall back to the shipped prebuild. */
async function resolveWinNodePtyPrebuild() {
  const hostTarget = `${plat(process.platform)}-${process.arch}`
  if (targetArg !== hostTarget) {
    throw new Error(
      `Cannot produce a ${targetArg} node-pty binary on a ${hostTarget} host. ` +
        'Build win32-x64 on a Windows (win32-x64) runner — there is no docker cross-build for Windows.',
    )
  }
  const ptyRoot = path.join(repoRoot, 'node_modules', 'node-pty')
  const release = path.join(ptyRoot, 'build', 'Release')
  if (existsSync(path.join(release, 'pty.node')) && existsSync(path.join(release, 'conpty.node'))) {
    return release
  }
  const shipped = path.join(ptyRoot, 'prebuilds', 'win32-x64')
  if (existsSync(path.join(shipped, 'pty.node'))) return shipped
  throw new Error(
    `win32 node-pty native not found (checked ${release} and ${shipped}). ` +
      'Run `npm install` on the Windows runner so node-pty is present.',
  )
}

/** Locate pty.node (+ spawn-helper on unix) for the target. */
async function resolveNativeBinaries() {
  const hostTarget = `${plat(process.platform)}-${process.arch}`

  // Native build: use the installed node-pty's host binary. Prefer the host's
  // own compiled output (build/Release, e.g. a from-source `node-gyp rebuild`)
  // and fall back to the prebuild node-pty ships for this platform. Both are
  // N-API, so the prebuild runs fine under the daemon's bundled Node — and a
  // prebuild-only install (e.g. `bun install`, which skips the from-source
  // path) has no build/Release. Mirrors resolveWinNodePtyPrebuild's fallback.
  if (targetArg === hostTarget) {
    const ptyRoot = path.join(repoRoot, 'node_modules', 'node-pty')
    for (const dir of [
      path.join(ptyRoot, 'build', 'Release'),
      path.join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`),
    ]) {
      const ptyNode = path.join(dir, 'pty.node')
      if (!existsSync(ptyNode)) continue
      const spawnHelper = path.join(dir, 'spawn-helper')
      return { ptyNode, spawnHelper: existsSync(spawnHelper) ? spawnHelper : null }
    }
    throw new Error(
      `node-pty pty.node missing for ${hostTarget} (checked build/Release and ` +
        `prebuilds/${process.platform}-${process.arch}). Run \`bun install\` / \`npm install\` first.`,
    )
  }

  // Cross build of the linux binary via a linux container (QEMU for arm64).
  if (useDocker && targetPlatform === 'linux') {
    return dockerBuildLinuxPty()
  }

  throw new Error(
    `Cannot produce a ${targetArg} node-pty binary on a ${hostTarget} host. ` +
      (targetPlatform === 'linux'
        ? 'Pass --docker to cross-build it, or run this on a matching CI runner.'
        : 'Run this on a matching runner (e.g. macos-13 for darwin-x64).'),
  )
}

/** Compile node-pty inside `node:20` for the target arch and extract its binaries. */
async function dockerBuildLinuxPty() {
  const outDir = path.join(os.tmpdir(), `cate-pty-${targetArg}-${NODE_PTY_VERSION}`)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  // node-pty builds spawn-helper on darwin only; on linux pty.node forks itself.
  const script =
    `set -e; mkdir -p /b && cd /b && npm init -y >/dev/null 2>&1 && ` +
    `npm i node-pty@${NODE_PTY_VERSION} --build-from-source >/dev/null 2>&1 && ` +
    `cp node_modules/node-pty/build/Release/pty.node /out/ && ` +
    `(cp node_modules/node-pty/build/Release/spawn-helper /out/ 2>/dev/null || true)`
  console.log(`[runtime] docker cross-building node-pty for ${targetArg} (QEMU; may be slow)…`)
  execFileSync(
    'docker',
    ['run', '--rm', '--platform', `linux/${targetArch === 'x64' ? 'amd64' : 'arm64'}`, '-v', `${outDir}:/out`, 'node:22', 'bash', '-lc', script],
    { stdio: 'inherit' },
  )
  const helper = path.join(outDir, 'spawn-helper')
  return { ptyNode: path.join(outDir, 'pty.node'), spawnHelper: existsSync(helper) ? helper : null }
}

/** Download just the `node` binary for the target into `outBin`. On win32 the
 *  runtime ships as node-v<ver>-win-x64.zip with node.exe at the archive root's
 *  node-v<ver>-win-x64/node.exe; elsewhere it's a .tar.gz with bin/node. */
async function stageNodeRuntime(platform, arch, outBin) {
  if (platform === 'win32') {
    const name = `node-v${NODE_VERSION}-win-${arch}`
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.zip`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`node runtime download failed: ${res.status} ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const tmp = path.join(os.tmpdir(), `cate-node-${platform}-${arch}-${NODE_VERSION}`)
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const zipPath = path.join(tmp, 'node.zip')
    await writeFile(zipPath, buf)
    unzipInto(zipPath, tmp)
    mkdirSync(path.dirname(outBin), { recursive: true })
    cpSync(path.join(tmp, name, 'node.exe'), outBin)
    rmSync(tmp, { recursive: true, force: true })
    console.log(`[runtime] staged node ${NODE_VERSION} runtime for win32-${arch}`)
    return
  }

  const name = `node-v${NODE_VERSION}-${platform}-${arch}`
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`node runtime download failed: ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmp = path.join(os.tmpdir(), `cate-node-${platform}-${arch}-${NODE_VERSION}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const tarPath = path.join(tmp, 'node.tar.gz')
  await writeFile(tarPath, buf)
  execFileSync('tar', ['-xzf', tarPath, '-C', tmp, `${name}/bin/node`], { stdio: 'ignore' })
  mkdirSync(path.dirname(outBin), { recursive: true })
  cpSync(path.join(tmp, name, 'bin', 'node'), outBin)
  chmodSync(outBin, 0o755)
  rmSync(tmp, { recursive: true, force: true })
  console.log(`[runtime] staged node ${NODE_VERSION} runtime for ${platform}-${arch}`)
}

/** Download just the `rg` binary for the target into `outBin`. The Windows asset
 *  is a .zip (ripgrep-<ver>-x86_64-pc-windows-msvc.zip) with rg.exe at the
 *  archive root's ${name}/rg.exe; the others are .tar.gz with ${name}/rg. */
async function stageRipgrep(target, outBin) {
  const triple = RIPGREP_TRIPLES[target]
  if (!triple) throw new Error(`no ripgrep triple for target "${target}"`)
  const name = `ripgrep-${RIPGREP_VERSION}-${triple}`
  const isWin = target.startsWith('win32-')
  const ext = isWin ? 'zip' : 'tar.gz'
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${name}.${ext}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ripgrep download failed: ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmp = path.join(os.tmpdir(), `cate-rg-${target}-${RIPGREP_VERSION}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  mkdirSync(path.dirname(outBin), { recursive: true })

  if (isWin) {
    const zipPath = path.join(tmp, 'rg.zip')
    await writeFile(zipPath, buf)
    unzipInto(zipPath, tmp)
    // The archive's top dir is `${name}/`; pull out only rg.exe.
    cpSync(path.join(tmp, name, 'rg.exe'), outBin)
    rmSync(tmp, { recursive: true, force: true })
    console.log(`[runtime] staged ripgrep ${RIPGREP_VERSION} for ${target}`)
    return
  }

  const tarPath = path.join(tmp, 'rg.tar.gz')
  await writeFile(tarPath, buf)
  // The archive's top dir is `${name}/`; pull out only the rg binary.
  execFileSync('tar', ['-xzf', tarPath, '-C', tmp, `${name}/rg`], { stdio: 'ignore' })
  cpSync(path.join(tmp, name, 'rg'), outBin)
  chmodSync(outBin, 0o755)
  rmSync(tmp, { recursive: true, force: true })
  console.log(`[runtime] staged ripgrep ${RIPGREP_VERSION} for ${target}`)
}

/** Stage the cross-platform pi coding agent into <outRoot> (pi/dist/cli.js …).
 *  pi rides in the runtime tarball so node + node-pty + rg + pi all ship as
 *  ONE per-target artifact — the daemon resolves pi from here, no on-demand
 *  download or air-gapped push. Builds the pi tarball first if it's absent. */
function stagePi(outRoot) {
  const piVersion = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf-8'),
  ).version
  const tar = path.join(dist, `cate-pi-${piVersion}.tgz`)
  if (!existsSync(tar)) {
    console.log('[runtime] pi tarball missing; building it…')
    execFileSync('node', [path.join(repoRoot, 'scripts', 'build-pi-tarball.mjs')], { stdio: 'inherit' })
  }
  if (!existsSync(tar)) throw new Error(`pi tarball not found at ${tar}`)
  rmSync(outRoot, { recursive: true, force: true })
  mkdirSync(outRoot, { recursive: true })
  // Basename archive + relative -C (cwd = the tarball's dir) — see `fwd`. The msys2
  // GNU tar in the release job's bash step can't chdir into a backslashed `D:\` -C.
  execFileSync('tar', ['-xzf', path.basename(tar), '-C', fwd(path.dirname(tar), outRoot)], { stdio: 'ignore', cwd: path.dirname(tar) })
  if (!existsSync(path.join(outRoot, 'dist', 'cli.js'))) throw new Error('staged pi missing dist/cli.js')
  console.log(`[runtime] staged pi ${piVersion}`)
}

/**
 * Codesign the bundled darwin Mach-O binaries with a Developer ID + hardened
 * runtime BEFORE they are tarred. Apple's notarytool recurses into the bundled
 * runtime-host.tgz and rejects unsigned binaries, so node, rg, node-pty's
 * pty.node/spawn-helper and @parcel/watcher's watcher.node must be signed like
 * the app. node also gets the runtime entitlements (JIT + disable-library-
 * validation) so it still runs and can load the native addons once hardened.
 * No-op unless we're building a darwin tarball on a darwin host with
 * CATE_MAC_SIGN_IDENTITY set (see ci-mac-signing-keychain.sh); when absent the
 * binaries stay unsigned and notarization fails loudly.
 */
function signMacNatives(stageDir) {
  const identity = process.env.CATE_MAC_SIGN_IDENTITY
  if (process.platform !== 'darwin' || targetPlatform !== 'darwin' || !identity) return
  const entitlements = path.join(repoRoot, 'build', 'entitlements.runtime.plist')
  const pbDir = path.join('node_modules', 'node-pty', 'prebuilds', targetArg)
  const binaries = [
    path.join('runtime', 'bin', 'node'),
    path.join('runtime', 'bin', 'rg'),
    path.join(pbDir, 'pty.node'),
    path.join(pbDir, 'spawn-helper'),
    path.join('node_modules', '@parcel', parcelBinaryDir(targetPlatform, targetArch), 'watcher.node'),
  ]
  // The identity is found via the keychain search list (ci-mac-signing-keychain.sh
  // adds the signing keychain to it); codesign --keychain alone is unreliable.
  for (const rel of binaries) {
    const file = path.join(stageDir, rel)
    if (!existsSync(file)) continue
    execFileSync(
      'codesign',
      ['--force', '--timestamp', '--options', 'runtime', '--entitlements', entitlements, '--sign', identity, file],
      { stdio: 'inherit' },
    )
    // Verify the seal now so a bad signature fails here, not later in notarytool.
    execFileSync('codesign', ['--verify', '--strict', file], { stdio: 'inherit' })
  }
  console.log(`[runtime] signed darwin natives for ${targetArg} (Developer ID ${identity})`)
}

function plat(p) {
  return p === 'win32' ? 'win32' : p // darwin | linux pass through
}
/** Extract a .zip into `destDir`, portably. Tries `unzip -o` first (Linux/macOS
 *  runners), then falls back to bsdtar's `tar -xf`, which transparently handles
 *  zips on macOS and on Windows (where tar IS bsdtar). The win tarball is built on
 *  a Windows runner, so the tar fallback covers it; CI Linux/macOS hosts have unzip. */
function unzipInto(zipPath, destDir) {
  try {
    execFileSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'ignore' })
    return
  } catch {
    // unzip absent (e.g. Windows runner) — fall through to bsdtar.
  }
  // Basename archive + relative -C (cwd = the zip's dir) — see `fwd`.
  execFileSync('tar', ['-xf', path.basename(zipPath), '-C', fwd(path.dirname(zipPath), destDir)], { stdio: 'ignore', cwd: path.dirname(zipPath) })
}
function valueOf(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}
