// =============================================================================
// Release host constants — used by the main process (companionArtifacts.ts) to
// resolve the per-target companion tarball download URLs. Keep in sync with the
// `publish:` block in electron-builder.yml.
// =============================================================================

export const GH_OWNER = '0-AI-UG'
export const GH_REPO = 'cate'

/** Release tag that hosts the companion + pi tarballs for an app version. */
export function releaseTag(appVersion: string): string {
  return `v${appVersion}`
}
