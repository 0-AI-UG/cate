// Writes a workspace's settings.json before its runtime starts, as a client
// setting them earlier would have (tests that start with network access on).

import fs from 'node:fs'
import path from 'node:path'
import { runtimeIdFromCanonicalRoot } from '@runtime/data/contract'
import { canonicalRoot, workspaceDataDir } from '@runtime/data/node'
import { WORKSPACE_SETTINGS_FILE } from '@kernel/settings/runtime'
import type { WorkspaceSettings } from '@panels/settings'

export async function seedWorkspaceSettings(root: string, home: string, values: Partial<WorkspaceSettings>): Promise<void> {
  const dir = workspaceDataDir(runtimeIdFromCanonicalRoot(await canonicalRoot(root)), home)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, WORKSPACE_SETTINGS_FILE), `${JSON.stringify(values, null, 2)}\n`)
}
