import os from 'os'
import path from 'path'

/** Retain the existing location so T3 credentials and conversations survive upgrades. */
export function hostHarnessRoot(): string {
  return process.env.CATE_HARNESS_ROOT || path.join(os.homedir(), '.cate', 'extensions', '.cate-t3')
}
