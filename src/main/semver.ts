// =============================================================================
// Minimal semver comparison — pure, dependency-free so it stays unit-testable
// in isolation (the auto-updater that consumes it pulls in electron + native
// modules). Handles only what the updater needs: x.y.z cores plus an optional
// pre-release suffix used for the beta channel (e.g. 1.2.0-beta.1).
// =============================================================================

/** A semver string with a pre-release suffix (e.g. 1.2.0-beta.1) identifies a
 *  beta / staged build. The presence of a `-` is the reliable signal. */
export function isPrereleaseVersion(version: string): boolean {
  return version.includes('-')
}

/** Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 *  Handles pre-release suffixes per semver: a pre-release ranks BELOW its
 *  release (1.2.0-beta.1 < 1.2.0), and two pre-releases of the same version are
 *  ordered by their dot-separated identifiers (numeric parts compared
 *  numerically). This matters for the beta channel so a tester on 1.2.0-beta.3
 *  rolls forward to stable 1.2.0 and to later betas, but not backwards. */
export function compareSemver(a: string, b: string): number {
  const [coreA, preA] = a.replace(/^v/, '').split('-', 2)
  const [coreB, preB] = b.replace(/^v/, '').split('-', 2)
  const na = coreA.split('.').map(Number)
  const nb = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (na[i] || 0) - (nb[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  // Same core version: no suffix outranks a pre-release suffix.
  if (!preA && !preB) return 0
  if (!preA) return 1
  if (!preB) return -1
  // Both pre-releases: compare identifiers left to right.
  const ida = preA.split('.')
  const idb = preB.split('.')
  for (let i = 0; i < Math.max(ida.length, idb.length); i++) {
    const xa = ida[i]
    const xb = idb[i]
    if (xa === undefined) return -1
    if (xb === undefined) return 1
    const numA = Number(xa)
    const numB = Number(xb)
    const bothNumeric = !Number.isNaN(numA) && !Number.isNaN(numB)
    const cmp = bothNumeric ? numA - numB : xa === xb ? 0 : xa > xb ? 1 : -1
    if (cmp !== 0) return cmp > 0 ? 1 : -1
  }
  return 0
}
