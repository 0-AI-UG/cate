// The install layout (architecture 7.1): `~/.cate/runtime/<build>/` holds the
// daemon bundle, its Node, the `cate` CLI, the patched T3 harness, bundled
// skills and native addons, exactly as the release tarball unpacks. One dir
// per build, never replaced, so two builds of one version (a checkout and the
// packaged app) install side by side. Pure: the caller passes the platform and
// the `~/.cate` directory.

export const GH_OWNER = '0-AI-UG'
export const GH_REPO = 'cate'

export const RUNTIME_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'] as const

export type RuntimeTarget = (typeof RUNTIME_TARGETS)[number]

export function isRuntimeTarget(value: string): value is RuntimeTarget {
  return (RUNTIME_TARGETS as readonly string[]).includes(value)
}

/** The tarball target for a platform and arch, or null where none is built. */
export function runtimeTarget(platform: string, arch: string): RuntimeTarget | null {
  const target = `${platform}-${arch}`
  return isRuntimeTarget(target) ? target : null
}

export function releaseTag(version: string): string {
  return `v${version}`
}

/** `cate-runtime-2.0.4-linux-x64.tgz` */
export function tarballName(version: string, target: RuntimeTarget): string {
  return `cate-runtime-${version}-${target}.tgz`
}

export function releaseUrl(version: string, target: RuntimeTarget): string {
  return `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${releaseTag(version)}/${tarballName(version, target)}`
}

/** The tarball's SHA-256 (`<hex>  <name>`), published beside it. */
export function checksumUrl(version: string, target: RuntimeTarget): string {
  return `${releaseUrl(version, target)}.sha256`
}

/** A build id (`scripts/build-id.mjs`): `<version>+<12 hex>`. */
export function isBuildId(value: string): boolean {
  return /^\d+\.\d+\.\d+(-[\w.-]+)?\+[0-9a-f]{12}$/.test(value)
}

/** The version part of a build id. */
export function buildVersion(build: string): string {
  return build.split('+', 1)[0]
}

/** Written last when an install completes; holds the build. */
export const INSTALL_MARKER = '.ok'

/** The tarball's build id, written by `scripts/build-runtime-tarball.mjs`. */
export const BUILD_FILE = 'BUILD'

/** `~/.cate/runtime/current`: the name of the install `cate` on PATH runs
 *  (`scripts/install.sh`), the last one installed or updated to. */
export const CURRENT_FILE = 'current'

function join(platform: string, ...parts: string[]): string {
  const sep = platform === 'win32' ? '\\' : '/'
  return parts
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)
}

/** `~/.cate/runtime` */
export function runtimeRoot(cateHome: string, platform: string): string {
  return join(platform, cateHome, 'runtime')
}

/** `~/.cate/runtime/<build>` */
export function runtimeInstallDir(cateHome: string, build: string, platform: string): string {
  return join(platform, cateHome, 'runtime', build)
}

/** Paths inside one install dir. Node and rg live under `runtime/bin/` on every
 *  platform; only the file name gains `.exe` on Windows. */
export function installLayout(installDir: string, platform: string) {
  const exe = platform === 'win32' ? '.exe' : ''
  const at = (...parts: string[]) => join(platform, installDir, ...parts)
  return {
    dir: installDir,
    bundle: at('runtime.cjs'),
    node: at('runtime', 'bin', `node${exe}`),
    ripgrep: at('runtime', 'bin', `rg${exe}`),
    t3: at('t3', 'dist', 'bin.mjs'),
    cateCli: at('cate', 'dist', 'cli.cjs'),
    cateBin: at('cate', 'bin'),
    skills: at('skills'),
    nodeModules: at('node_modules'),
    marker: at(INSTALL_MARKER),
    build: at(BUILD_FILE),
  }
}

/** The install dir a daemon runs from: its Node is `<dir>/runtime/bin/node`. */
export function installDirFromExecPath(execPath: string, platform: string): string {
  const parts = execPath.split(/[\\/]+/)
  const sep = platform === 'win32' ? '\\' : '/'
  return parts.slice(0, -3).join(sep) || sep
}

