// The folder a file drag over a file tree would land in: the folder row under
// the cursor, or the folder of the file row under it. That folder's row
// highlights, so a drop over any of its children shows where it goes. One
// drag at a time, so one value for every tree.

import { create } from 'zustand'

export const useTreeDropDir = create<{ dir: string | null }>(() => ({ dir: null }))

export function setTreeDropDir(dir: string | null): void {
  if (useTreeDropDir.getState().dir !== dir) useTreeDropDir.setState({ dir })
}
