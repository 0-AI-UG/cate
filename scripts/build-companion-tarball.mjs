// =============================================================================
// Build ONE self-contained cate-companion tarball for a single target:
//
//   dist-companion/cate-companion-<version>-<target>.tgz
//     companion.cjs                       (esbuild bundle, runtime-agnostic)
//     node_modules/node-pty/...           (with prebuilds/<target>/pty.node
//                                          + spawn-helper — the only native dep)
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
//   node scripts/build-companion-tarball.mjs                 # host target
//   node scripts/build-companion-tarball.mjs --target linux-x64
//   node scripts/build-companion-tarball.mjs --target linux-x64 --docker
//
// On CI, run this NATIVELY on the matching runner (ubuntu for linux-*, macos
// for darwin-*) so node-pty's binary is the runner's own compiled output. The
// --docker flag cross-builds the linux node-pty binary on a non-linux host
// (e.g. a Mac) for local end-to-end testing before CI exists.
// =============================================================================

import { existsSync, mkdirSync, cpSync, rmSync, chmodSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { companionBuildOptions, syncCompanionVersion } from '../src/companion/build/esbuild.config.mjs'

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
const dist = path.join(repoRoot, 'dist-companion')

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
  console.error(`[companion] unsupported target "${targetArg}". One of: ${SUPPORTED.join(', ')}`)
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
const outTar = path.join(dist, `cate-companion-${version}-${targetArg}.tgz`)
rmSync(outTar, { force: true })

// Unified runtime/bin/ layout; only the filename gains a `.exe` on win32 so the
// install-dir depth (and thus the resolvers) stay identical across platforms.
cpSync(path.join(dist, 'companion.cjs'), path.join(stageDir, 'companion.cjs'))
await stageNodePty(stageDir)
await stageNodeRuntime(targetPlatform, targetArch, path.join(stageDir, 'runtime', 'bin', `node${exe}`))
await stageRipgrep(targetArg, path.join(stageDir, 'runtime', 'bin', `rg${exe}`))
stagePi(path.join(stageDir, 'pi'))
signMacNatives(stageDir)

// Fail loudly if anything the daemon's install-probe requires is missing, rather
// than shipping a tarball that extracts but never satisfies isInstalled (every
// connect would then re-push it). These are the exact paths sshTransport's
// dev-mode isInstalled checks.
const required = [
  `companion.cjs`,
  path.join('runtime', 'bin', `node${exe}`),
  path.join('runtime', 'bin', `rg${exe}`),
  path.join('pi', 'dist', 'cli.js'),
]
const missing = required.filter((rel) => !existsSync(path.join(stageDir, rel)))
if (missing.length) throw new Error(`[companion] incomplete stage for ${targetArg}; missing: ${missing.join(', ')}`)

// --no-xattrs: don't archive extended attributes (macOS keeps re-stamping a
// com.apple.provenance xattr that otherwise makes GNU tar warn on extraction
// on the Ubuntu server). Supported by both bsdtar and GNU tar. Basename + relative
// -C (cwd = dist) keep Windows drive letters out of tar's path args — see `fwd`.
execFileSync('tar', ['--no-xattrs', '-czf', path.basename(outTar), '-C', fwd(dist, stageDir), '.'], { stdio: 'inherit', cwd: dist })
console.log(`[companion] wrote ${path.relative(repoRoot, outTar)}`)

// --------------------------------------------------------------------------

async function buildBundle() {
  const v = syncCompanionVersion()
  await build(companionBuildOptions)
  if (!existsSync(path.join(dist, 'companion.cjs'))) throw new Error('esbuild did not produce companion.cjs')
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
    console.log(`[companion] staged node-pty win32 conpty native for ${targetArg}`)
    return
  }

  const { ptyNode, spawnHelper } = await resolveNativeBinaries()
  cpSync(ptyNode, path.join(pbDir, 'pty.node'))
  chmodSync(path.join(pbDir, 'pty.node'), 0o755)
  if (spawnHelper) {
    cpSync(spawnHelper, path.join(pbDir, 'spawn-helper'))
    chmodSync(path.join(pbDir, 'spawn-helper'), 0o755)
  }
  console.log(`[companion] staged node-pty native for ${targetArg}`)
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
      `[companion] WARNING: staged win32 node-pty missing winpty fallback file(s): ` +
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

  // Native build: the installed node-pty was compiled for the host.
  if (targetArg === hostTarget) {
    const rel = path.join(repoRoot, 'node_modules', 'node-pty', 'build', 'Release')
    const ptyNode = path.join(rel, 'pty.node')
    if (!existsSync(ptyNode)) throw new Error(`node-pty build/Release/pty.node missing for ${hostTarget}`)
    const spawnHelper = path.join(rel, 'spawn-helper')
    return { ptyNode, spawnHelper: existsSync(spawnHelper) ? spawnHelper : null }
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
  console.log(`[companion] docker cross-building node-pty for ${targetArg} (QEMU; may be slow)…`)
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
    console.log(`[companion] staged node ${NODE_VERSION} runtime for win32-${arch}`)
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
  console.log(`[companion] staged node ${NODE_VERSION} runtime for ${platform}-${arch}`)
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
    console.log(`[companion] staged ripgrep ${RIPGREP_VERSION} for ${target}`)
    return
  }

  const tarPath = path.join(tmp, 'rg.tar.gz')
  await writeFile(tarPath, buf)
  // The archive's top dir is `${name}/`; pull out only the rg binary.
  execFileSync('tar', ['-xzf', tarPath, '-C', tmp, `${name}/rg`], { stdio: 'ignore' })
  cpSync(path.join(tmp, name, 'rg'), outBin)
  chmodSync(outBin, 0o755)
  rmSync(tmp, { recursive: true, force: true })
  console.log(`[companion] staged ripgrep ${RIPGREP_VERSION} for ${target}`)
}

/** Stage the cross-platform pi coding agent into <outRoot> (pi/dist/cli.js …).
 *  pi rides in the companion tarball so node + node-pty + rg + pi all ship as
 *  ONE per-target artifact — the daemon resolves pi from here, no on-demand
 *  download or air-gapped push. Builds the pi tarball first if it's absent. */
function stagePi(outRoot) {
  const piVersion = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf-8'),
  ).version
  const tar = path.join(dist, `cate-pi-${piVersion}.tgz`)
  if (!existsSync(tar)) {
    console.log('[companion] pi tarball missing; building it…')
    execFileSync('node', [path.join(repoRoot, 'scripts', 'build-pi-tarball.mjs')], { stdio: 'inherit' })
  }
  if (!existsSync(tar)) throw new Error(`pi tarball not found at ${tar}`)
  rmSync(outRoot, { recursive: true, force: true })
  mkdirSync(outRoot, { recursive: true })
  // Basename archive + relative -C (cwd = the tarball's dir) — see `fwd`. The msys2
  // GNU tar in the release job's bash step can't chdir into a backslashed `D:\` -C.
  execFileSync('tar', ['-xzf', path.basename(tar), '-C', fwd(path.dirname(tar), outRoot)], { stdio: 'ignore', cwd: path.dirname(tar) })
  if (!existsSync(path.join(outRoot, 'dist', 'cli.js'))) throw new Error('staged pi missing dist/cli.js')
  console.log(`[companion] staged pi ${piVersion}`)
}

/**
 * Codesign the bundled darwin Mach-O binaries with a Developer ID + hardened
 * runtime BEFORE they are tarred. Apple's notarytool recurses into the bundled
 * companion-host.tgz and rejects unsigned binaries, so node, rg and node-pty's
 * pty.node/spawn-helper must be signed like the app. node also gets the
 * companion entitlements (JIT + disable-library-validation) so it still runs and
 * can load pty.node once hardened. No-op unless we're building a darwin tarball
 * on a darwin host with CATE_MAC_SIGN_IDENTITY set (see ci-mac-signing-keychain.sh);
 * when absent the binaries stay unsigned and notarization fails loudly.
 */
function signMacNatives(stageDir) {
  const identity = process.env.CATE_MAC_SIGN_IDENTITY
  if (process.platform !== 'darwin' || targetPlatform !== 'darwin' || !identity) return
  const entitlements = path.join(repoRoot, 'build', 'entitlements.companion.plist')
  const pbDir = path.join('node_modules', 'node-pty', 'prebuilds', targetArg)
  const binaries = [
    path.join('runtime', 'bin', 'node'),
    path.join('runtime', 'bin', 'rg'),
    path.join(pbDir, 'pty.node'),
    path.join(pbDir, 'spawn-helper'),
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
  console.log(`[companion] signed darwin natives for ${targetArg} (Developer ID ${identity})`)
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
