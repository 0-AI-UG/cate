// =============================================================================
// ripgrepPath — resolve the bundled ripgrep binary at runtime.
//
// @vscode/ripgrep exports `rgPath` pointing at the platform binary (e.g.
// node_modules/@vscode/ripgrep-darwin-arm64/bin/rg). In a packaged build that
// path sits under app.asar; the binary is unpacked to app.asar.unpacked, so we
// apply the same .asar -> .asar.unpacked swap used by marketplace.ts.
// =============================================================================

import { rgPath } from '@vscode/ripgrep'

let cached: string | null = null

export function getRgPath(): string {
  if (cached) return cached
  cached =
    rgPath.includes('app.asar') && !rgPath.includes('app.asar.unpacked')
      ? rgPath.replace('app.asar', 'app.asar.unpacked')
      : rgPath
  return cached
}
