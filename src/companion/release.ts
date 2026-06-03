// =============================================================================
// Release host constants — shared by the main process (companionArtifacts.ts)
// and the standalone daemon (which pulls the pi tarball itself). Keep in sync
// with the `publish:` block in electron-builder.yml.
// =============================================================================

export const GH_OWNER = '0-AI-UG'
export const GH_REPO = 'cate'

/** Release tag that hosts the companion + pi tarballs for an app version. */
export function releaseTag(appVersion: string): string {
  return `v${appVersion}`
}

/** `cate-pi-0.75.4.tgz` */
export function piTarballName(piVersion: string): string {
  return `cate-pi-${piVersion}.tgz`
}

/** Public download URL for the cross-platform pi tarball. */
export function piReleaseUrl(appVersion: string, piVersion: string): string {
  return `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${releaseTag(appVersion)}/${piTarballName(piVersion)}`
}
