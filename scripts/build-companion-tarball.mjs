// =============================================================================
// Build ONE self-contained cate-companion tarball for a single target:
//
//   dist-companion/cate-companion-<version>-<target>.tgz
//     companion.cjs                       (esbuild bundle, runtime-agnostic)
//     node_modules/node-pty/...           (with prebuilds/<target>/pty.node
//                                          + spawn-helper — the only native dep)
//     runtime/bin/node                    (bundled Node runtime for the target)
//     runtime/bin/rg                       (bundled ripgrep for content search)
//
// node-pty resolves its native binary from prebuilds/<platform>-<arch>/ (see
// node-pty/lib/utils.js), and the npm package ships NO linux prebuild — so we
// stage the binary there ourselves, compiled for the target.
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

import { existsSync, mkdirSync, cpSync, rmSync, chmodSync, renameSync } from 'node:fs'
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
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(repoRoot, 'dist-companion')

const args = process.argv.slice(2)
const useDocker = args.includes('--docker')
const targetArg = valueOf('--target') ?? `${plat(process.platform)}-${process.arch}`
const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
if (!SUPPORTED.includes(targetArg)) {
  console.error(`[companion] unsupported target "${targetArg}". One of: ${SUPPORTED.join(', ')}`)
  process.exit(1)
}
const [targetPlatform, targetArch] = targetArg.split('-')

const version = await buildBundle()
const stageDir = path.join(dist, 'stage', targetArg)
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })

cpSync(path.join(dist, 'companion.cjs'), path.join(stageDir, 'companion.cjs'))
await stageNodePty(stageDir)
await stageNodeRuntime(targetPlatform, targetArch, path.join(stageDir, 'runtime', 'bin', 'node'))
await stageRipgrep(targetArg, path.join(stageDir, 'runtime', 'bin', 'rg'))

const outTar = path.join(dist, `cate-companion-${version}-${targetArg}.tgz`)
rmSync(outTar, { force: true })
// --no-xattrs: don't archive extended attributes (macOS keeps re-stamping a
// com.apple.provenance xattr that otherwise makes GNU tar warn on extraction
// on the Ubuntu server). Supported by both bsdtar and GNU tar.
execFileSync('tar', ['--no-xattrs', '-czf', outTar, '-C', stageDir, '.'], { stdio: 'inherit' })
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

  const { ptyNode, spawnHelper } = await resolveNativeBinaries()
  const pbDir = path.join(dest, 'prebuilds', targetArg)
  mkdirSync(pbDir, { recursive: true })
  cpSync(ptyNode, path.join(pbDir, 'pty.node'))
  chmodSync(path.join(pbDir, 'pty.node'), 0o755)
  if (spawnHelper) {
    cpSync(spawnHelper, path.join(pbDir, 'spawn-helper'))
    chmodSync(path.join(pbDir, 'spawn-helper'), 0o755)
  }
  console.log(`[companion] staged node-pty native for ${targetArg}`)
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

/** Download just the `node` binary for the target into `outBin`. */
async function stageNodeRuntime(platform, arch, outBin) {
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
  renameSync(path.join(tmp, name, 'bin', 'node'), outBin)
  chmodSync(outBin, 0o755)
  rmSync(tmp, { recursive: true, force: true })
  console.log(`[companion] staged node ${NODE_VERSION} runtime for ${platform}-${arch}`)
}

/** Download just the `rg` binary for the target into `outBin`. */
async function stageRipgrep(target, outBin) {
  const triple = RIPGREP_TRIPLES[target]
  if (!triple) throw new Error(`no ripgrep triple for target "${target}"`)
  const name = `ripgrep-${RIPGREP_VERSION}-${triple}`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${name}.tar.gz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ripgrep download failed: ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmp = path.join(os.tmpdir(), `cate-rg-${target}-${RIPGREP_VERSION}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const tarPath = path.join(tmp, 'rg.tar.gz')
  await writeFile(tarPath, buf)
  // The archive's top dir is `${name}/`; pull out only the rg binary.
  execFileSync('tar', ['-xzf', tarPath, '-C', tmp, `${name}/rg`], { stdio: 'ignore' })
  mkdirSync(path.dirname(outBin), { recursive: true })
  renameSync(path.join(tmp, name, 'rg'), outBin)
  chmodSync(outBin, 0o755)
  rmSync(tmp, { recursive: true, force: true })
  console.log(`[companion] staged ripgrep ${RIPGREP_VERSION} for ${target}`)
}

function plat(p) {
  return p === 'win32' ? 'win32' : p // darwin | linux pass through
}
function valueOf(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}
