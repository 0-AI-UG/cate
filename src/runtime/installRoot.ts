// =============================================================================
// installRoot is the runtime install dir shared by the bundled T3 and cate CLIs.
// process.execPath == <installDir>/runtime/bin/node[.exe], so the dir is two
// levels up. The unified runtime/bin/ layout keeps node under runtime/bin/ on
// win32 too (just node.exe), so the dirname×3 depth is identical across
// platforms and this stays correct. T3 sits at <installDir>/t3, the cate CLI at
// <installDir>/cate.
// =============================================================================

import path from 'path'

export function installRoot(): string {
  return path.resolve(path.dirname(process.execPath), '..', '..')
}
