// =============================================================================
// RuntimeTransport — how a daemon is launched and reached. All transports
// resolve to a duplex line pipe (RuntimeChannel) that the RuntimeRpcClient
// sits on; only bootstrap/launch differ between local subprocess, SSH, and WSL.
// =============================================================================

export interface RuntimeChannel {
  /** Write one already-serialized frame line to the daemon's stdin. */
  write(line: string): void
  /** Register the stdout data handler. Called once, synchronously after launch. */
  onData(cb: (chunk: string | Buffer) => void): void
  /** Register a stderr handler — surfaced in connect errors so a daemon that
   *  fails to start (node missing, node-pty missing, …) gives a real reason. */
  onStderr?(cb: (chunk: string | Buffer) => void): void
  /** Register the close handler (process exit / connection drop). */
  onClose(cb: (info: { code: number | null }) => void): void
  /** Forcibly terminate the daemon / close the connection. */
  kill(): void
}

// -----------------------------------------------------------------------------
// Shared remote-install helpers — SSH and WSL provision the SAME self-contained
// tarball into the SAME `~/.cate/runtime/<ver>/<target>` layout with identical
// markers, pull commands, and dev hot-swap flow; only the push mechanism (SFTP
// vs /mnt copy) and the exec primitive differ. These keep that logic in one
// place. localTransport keeps its own fs-based marker()/install (it never shells).
// -----------------------------------------------------------------------------

import log from '../../logger'
import { localRuntimeBundlePath, localTarballIfPresent, isRuntimeDevMode, releaseUrl, tarballHash, type RuntimeTarget } from '../runtimeArtifacts'

/** Minimal POSIX shell-quote for argv interpolated into a remote command string. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Result of running a shell command on a remote host (never throws form). */
export interface RemoteExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Compute the `.ok` freshness marker. When a local tarball is present (dev build
 *  / cache) it embeds the tarball's content hash so a changed daemon at the same
 *  version re-installs automatically; otherwise (production pull) it is just the
 *  version. */
export async function computeMarker(version: string, localTar: string | null): Promise<string> {
  return localTar ? `${version}:${await tarballHash(localTar)}` : version
}

/** Whether a host's stored `.ok` marker means the correct bundle is installed.
 *  Exact match on the hash-aware marker, or (no local tarball) a version prefix
 *  match so a production pull whose marker is just the version still counts. */
export function markersMatch(ok: string, marker: string, localTar: string | null, version: string): boolean {
  return ok === marker || (!localTar && ok.startsWith(version))
}

/** sh test that the current-version bundle is installed: node runtime + cjs
 *  present and the `.ok` marker readable (its bytes are matched by markersMatch).
 *  `quotedInstallDir` must be shell-quoted (as provisionedProbe expects). */
export function buildInstallCheckCommand(quotedInstallDir: string): string {
  return `test -x ${quotedInstallDir}/runtime/bin/node && test -f ${quotedInstallDir}/runtime.cjs && cat ${quotedInstallDir}/.ok 2>/dev/null`
}

/** sh tail run from inside the install dir after the tarball is in place as
 *  `pkg.tgz`: extract -> verify runtime + cjs -> write the `.ok` marker -> echo
 *  the success token. `quotedMarker` must already be shell-quoted; `okToken` is
 *  the sentinel the caller greps for (CATE_EXTRACT_OK / CATE_PULL_OK). */
export function buildExtractCommand(quotedMarker: string, okToken: string): string {
  return (
    `tar -xzf pkg.tgz && rm -f pkg.tgz && ` +
    `test -x runtime/bin/node && test -f runtime.cjs && ` +
    `printf %s ${quotedMarker} > .ok && echo ${okToken}`
  )
}

/** Compound sh command: download (curl|wget) -> extract -> verify -> mark `.ok`.
 *  Echoes CATE_PULL_OK on success; CATE_NO_FETCHER + exit 3 when neither tool. */
export function buildRemotePullCommand(installDir: string, url: string, version: string): string {
  const D = shellQuote(installDir)
  const U = shellQuote(url)
  const V = shellQuote(version)
  return (
    `mkdir -p ${D} && cd ${D} && rm -f pkg.tgz && ` +
    `if command -v curl >/dev/null 2>&1; then curl -fSL ${U} -o pkg.tgz; ` +
    `elif command -v wget >/dev/null 2>&1; then wget -qO pkg.tgz ${U}; ` +
    `else echo CATE_NO_FETCHER >&2; exit 3; fi && ` +
    buildExtractCommand(V, 'CATE_PULL_OK')
  )
}

/** sh test that the heavy parts are provisioned (runtime + rg + pi + cjs +
 *  node_modules). Echoes CATE_PROVISIONED when all present. `D` must be shell-quoted. */
export function provisionedProbe(quotedInstallDir: string): string {
  return `test -x ${quotedInstallDir}/runtime/bin/node && test -x ${quotedInstallDir}/runtime/bin/rg && test -f ${quotedInstallDir}/pi/dist/cli.js && test -f ${quotedInstallDir}/runtime.cjs && test -d ${quotedInstallDir}/node_modules && echo CATE_PROVISIONED`
}

/** Transport-specific bits the shared dev provisioner needs. */
export interface BootstrapDevDeps {
  /** Log tag, e.g. 'ssh' / 'wsl'. */
  tag: 'ssh' | 'wsl'
  /** Run a shell command on the host (must not throw; returns code+output). */
  exec(cmd: string): Promise<RemoteExecResult>
  /** Full-tarball provision into the install dir, writing the given `.ok` marker. */
  pushTarball(version: string, marker: string): Promise<void>
  /** Overlay just the freshest local runtime.cjs onto an already-provisioned
   *  host and write `.cjs.ok = hash` (SFTP put / wslpath cp). `D` is shell-quoted. */
  pushBundle(bundle: string, hash: string, quotedInstallDir: string): Promise<void>
}

/**
 * Dev provisioning shared by SSH and WSL. Installs the heavy parts (runtime +
 * node_modules + node-pty) from the local tarball once, then overlays the
 * freshest local runtime.cjs keyed by its content hash in `.cjs.ok`. Subsequent
 * connects with an unchanged bundle are a single hash check; a changed bundle is a
 * ~262KB push. Never remote-pulls — the host runs whatever `build:runtime` last
 * produced. `D` is the shell-quoted install dir.
 */
export async function bootstrapDevShared(version: string, D: string, deps: BootstrapDevDeps): Promise<void> {
  const provisioned = (await deps.exec(provisionedProbe(D))).stdout.includes('CATE_PROVISIONED')

  // First connect on this host/version: lay down runtime + node_modules from the
  // local tarball (marker is just the version; the cjs overlay below is the real
  // freshness key in dev). No remote-pull.
  if (!provisioned) await deps.pushTarball(version, version)

  const bundle = localRuntimeBundlePath()
  if (!bundle) {
    if (!provisioned) return // just installed from the tarball; nothing newer to push
    log.warn('[runtime:%s] dev mode but dist-runtime/runtime.cjs missing; run `npm run build:runtime`', deps.tag)
    return
  }

  const h = await tarballHash(bundle)
  const ok = (await deps.exec(`cat ${D}/.cjs.ok 2>/dev/null`)).stdout.trim()
  if (provisioned && ok === h) return // host already runs this exact bundle

  await deps.pushBundle(bundle, h, D)
  log.info('[runtime:%s] dev fast-push runtime.cjs (%s)', deps.tag, h)
}

/** Transport-specific bits the shared install probe + prod provisioner need. */
export interface BootstrapProdDeps {
  /** Log tag, e.g. 'ssh' / 'wsl'. */
  tag: 'ssh' | 'wsl'
  /** The resolved runtime target (used for tarball lookup + success log). */
  target: RuntimeTarget
  /** UNQUOTED install dir; the prod pull quotes internally via shellQuote. */
  installDir: string
  /** Run a shell command on the host (must not throw; returns code+output). */
  exec(cmd: string): Promise<RemoteExecResult>
  /** Full-tarball provision into the install dir, writing the given `.ok` marker
   *  (SFTP push / /mnt copy). */
  pushTarball(version: string, marker: string): Promise<void>
  /** Fallback log line when the host can't fetch its own tarball — wording
   *  differs per transport (SFTP push vs /mnt copy), so it's passed in full. The
   *  `%s` placeholder is filled with the pull failure reason. */
  pullFallbackLabel: string
}

/** Reachable + correct-version bundle present? Does NOT install. Shared by SSH
 *  and WSL isInstalled(): in dev the freshness key is the provisioned core (the
 *  cjs hot-swap is part of install, not the probe); in prod it's the `.ok`
 *  marker. `D` is the shell-quoted install dir. */
export async function isInstalledShared(
  version: string,
  D: string,
  target: RuntimeTarget,
  exec: (cmd: string) => Promise<RemoteExecResult>,
): Promise<boolean> {
  if (isRuntimeDevMode()) {
    return (await exec(provisionedProbe(D))).stdout.includes('CATE_PROVISIONED')
  }
  const localTar = localTarballIfPresent(version, target)
  const marker = await computeMarker(version, localTar)
  const ok = (await exec(buildInstallCheckCommand(D))).stdout.trim()
  return markersMatch(ok, marker, localTar, version)
}

/**
 * Production provisioning shared by SSH and WSL. Marker stored in `.ok`: when a
 * local tarball is present (dev build / cache) it embeds its content hash so a
 * changed daemon at the same version re-installs, otherwise it's just the version.
 * Returns early if already installed and current. First tries a host-side
 * remote/in-distro pull from the release; if the host can't fetch, falls back to
 * a client-side push (SFTP / /mnt). `D` is the shell-quoted install dir.
 */
export async function bootstrapProdShared(version: string, D: string, deps: BootstrapProdDeps): Promise<void> {
  const localTar = localTarballIfPresent(version, deps.target)
  const marker = await computeMarker(version, localTar)

  // Already installed and current?
  const installed = await deps.exec(buildInstallCheckCommand(D))
  const ok = installed.stdout.trim()
  if (markersMatch(ok, marker, localTar, version)) return

  // 1. Remote / in-distro pull — let the host fetch its own tarball from the release.
  const url = releaseUrl(version, deps.target)
  const pull = await deps.exec(buildRemotePullCommand(deps.installDir, url, version))
  if (pull.stdout.includes('CATE_PULL_OK')) {
    log.info('[runtime:%s] %s pulled tarball from release', deps.tag, deps.target)
    return
  }
  log.info(deps.pullFallbackLabel, pull.stderr.trim() || `code ${pull.code}`)

  // 2. Client-side fallback — download/copy the tarball and push it.
  await deps.pushTarball(version, marker)
}

export interface RuntimeTransport {
  readonly kind: 'local' | 'server' | 'wsl'
  /**
   * Probe whether the correct-version daemon bundle is already installed on the
   * host, WITHOUT installing anything. Connecting the transport happens here, so
   * a failure to reach the host surfaces (the manager maps it to `unreachable`);
   * resolving `false` means the host is reachable but the daemon needs to be
   * installed (the manager maps that to `missing`). Optional — a transport that
   * omits it is treated as always-installed (local subprocess / in-proc fakes).
   */
  isInstalled?(expectedVersion: string): Promise<boolean>
  /** Ensure the correct-version runtime bundle is present on the host. When
   *  `force` is set, wipe any existing install first so a corrupt or partial
   *  bundle is replaced by a clean download/push+extract (the reinstall path). */
  bootstrap(expectedVersion: string, force?: boolean): Promise<void>
  /** Remove the runtime install from the host (rm -rf ~/.cate/runtime).
   *  Backs the explicit "Delete runtime" action. Optional — omitted by
   *  transports with nothing host-side to remove. */
  uninstall?(): Promise<void>
  /** Launch the daemon and return its stdio channel. */
  launch(): Promise<RuntimeChannel>
  /** Release transport-level resources (SSH connection, etc.). */
  dispose(): Promise<void>
}
