import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

// Keep the native addon on the same practical glibc floor as the official
// bundled Node binary. These immutable per-platform manifests are from the
// official node:22.19.0-bullseye image.
export const LINUX_GLIBC_BASELINE = '2.28'
export const LINUX_NODE_PTY_BUILD_IMAGES = {
  x64: 'node@sha256:518f8f89a5a95cbe7c006b40b5f6db0dac6387161fff83694595455e01023156',
  arm64: 'node@sha256:38a9218715c147fb40c9a970fe74ad3e11017df1d03b4738f4604fed3ea4dfd4',
}

function compareVersions(a, b) {
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const difference = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function requiredGlibcVersions(versionInfo) {
  return [...new Set([...versionInfo.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)].map((match) => match[1]))]
    .sort(compareVersions)
}

export function assertLinuxGlibcBaseline(versionInfo, baseline = LINUX_GLIBC_BASELINE) {
  const versions = requiredGlibcVersions(versionInfo)
  if (versions.length === 0) throw new Error('readelf did not report any GLIBC symbol versions for pty.node')
  const newest = versions.at(-1)
  if (compareVersions(newest, baseline) > 0) {
    throw new Error(`pty.node requires GLIBC_${newest}, newer than the supported GLIBC_${baseline} baseline`)
  }
  return newest
}

export function buildLinuxNodePty({ targetArch, nodePtyVersion, outDir }) {
  if (targetArch !== 'x64' && targetArch !== 'arm64') {
    throw new Error(`Unsupported Linux node-pty architecture: ${targetArch}`)
  }
  if (!/^[0-9A-Za-z.+-]+$/.test(nodePtyVersion)) {
    throw new Error(`Invalid node-pty version: ${nodePtyVersion}`)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const ptyNode = path.join(outDir, 'pty.node')
  const versionInfo = path.join(outDir, 'pty.node.version-info')
  const script =
    `set -e; mkdir -p /b && cd /b && npm init -y >/dev/null 2>&1 && ` +
    `npm i node-pty@${nodePtyVersion} --build-from-source --no-audit --no-fund >/dev/null 2>&1 && ` +
    `cp node_modules/node-pty/build/Release/pty.node /out/ && ` +
    `readelf --version-info --wide node_modules/node-pty/build/Release/pty.node > /out/pty.node.version-info`

  console.log(`[runtime] docker building node-pty for linux-${targetArch} with a GLIBC_${LINUX_GLIBC_BASELINE} ceiling…`)
  execFileSync(
    'docker',
    [
      'run', '--rm',
      '--platform', `linux/${targetArch === 'x64' ? 'amd64' : 'arm64'}`,
      '-v', `${outDir}:/out`,
      LINUX_NODE_PTY_BUILD_IMAGES[targetArch],
      'bash', '-lc', script,
    ],
    { stdio: 'inherit' },
  )

  if (!existsSync(ptyNode) || !existsSync(versionInfo)) {
    throw new Error(`Linux node-pty build did not produce pty.node and its readelf report in ${outDir}`)
  }
  const newestGlibc = assertLinuxGlibcBaseline(readFileSync(versionInfo, 'utf-8'))
  rmSync(versionInfo, { force: true })
  console.log(`[runtime] verified linux-${targetArch} node-pty requires at most GLIBC_${newestGlibc}`)
  return { ptyNode, spawnHelper: null }
}
