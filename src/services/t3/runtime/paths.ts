import { createHash } from 'node:crypto'
import path from 'node:path'

/** Hash of the canonical checkout: names its instance directory. */
export function t3InstanceId(checkout: string): string {
  return createHash('sha256').update(checkout).digest('hex').slice(0, 16)
}

/** Files of the workspace's T3 root (`<data>/t3/`) for one checkout. */
export function t3Paths(t3Root: string, checkout: string) {
  const instanceId = t3InstanceId(checkout)
  const instancesRoot = path.join(t3Root, 'instances')
  const baseDir = path.join(instancesRoot, instanceId)
  const userdata = path.join(baseDir, 'userdata')
  return {
    root: t3Root,
    instanceId,
    instancesRoot,
    baseDir,
    userdata,
    settings: path.join(userdata, 'settings.json'),
    secrets: path.join(userdata, 'secrets'),
    caches: path.join(baseDir, 'caches'),
    providerProfile: path.join(t3Root, 'provider-profile.json'),
    providerSecrets: path.join(t3Root, 'provider-secrets'),
  }
}

export type T3Paths = ReturnType<typeof t3Paths>
