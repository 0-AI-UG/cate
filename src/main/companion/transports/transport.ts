// =============================================================================
// CompanionTransport — how a daemon is launched and reached. All transports
// resolve to a duplex line pipe (CompanionChannel) that the CompanionRpcClient
// sits on; only bootstrap/launch differ between local subprocess, SSH, and WSL.
// =============================================================================

export interface CompanionChannel {
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

export interface CompanionTransport {
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
  /** Ensure the correct-version companion bundle is present on the host. When
   *  `force` is set, wipe any existing install first so a corrupt or partial
   *  bundle is replaced by a clean download/push+extract (the reinstall path). */
  bootstrap(expectedVersion: string, force?: boolean): Promise<void>
  /** Remove the companion install from the host (rm -rf ~/.cate/companion).
   *  Backs the explicit "Delete companion" action. Optional — omitted by
   *  transports with nothing host-side to remove. */
  uninstall?(): Promise<void>
  /** Launch the daemon and return its stdio channel. */
  launch(): Promise<CompanionChannel>
  /**
   * AIR-GAPPED FALLBACK for the pi tarball, symmetric to the companion-tarball
   * SFTP/copy fallback. Called when the daemon's own `ensurePiOnHost` fails to
   * download pi (host has no internet). The client downloads the pi tarball
   * (companionArtifacts.ensureLocalPiTarball) and pushes it to
   * ~/.cate/pi/<piVersion>/pkg.tgz on the host, where the daemon's re-invoked
   * ensure extracts it. Idempotent: skips when pi is already installed. Optional
   * because only remote transports (ssh/wsl) need it.
   */
  pushPi?(appVersion: string, piVersion: string): Promise<void>
  /** Release transport-level resources (SSH connection, etc.). */
  dispose(): Promise<void>
}
