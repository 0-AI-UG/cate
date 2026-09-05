import { createHash } from 'crypto'
import path from 'path'
import { RUNTIME_NODE_EXECUTABLE } from '../runtime/types'

export function runtimePath(runtimeId: string, ...parts: string[]): string {
  return runtimeId === 'local' ? path.join(...parts) : path.posix.join(...parts)
}

export function harnessKey(runtimeId: string, cwd: string): string {
  return `${runtimeId}:${cwd}`
}

export function partitionFor(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return `persist:cate-t3-${hash}`
}

export function harnessNodeExecutable(
  runtimeId: string,
  isPackaged: boolean,
  devNodeExecutable: string | undefined = process.env.npm_node_execpath,
): string {
  if (runtimeId !== 'local' || isPackaged) return RUNTIME_NODE_EXECUTABLE
  return devNodeExecutable?.trim() || 'node'
}

export function harnessPaths(runtimeId: string, extensionsRoot: string, cwd: string): {
  harnessRoot: string
  instancesRoot: string
  baseDir: string
  providerProfilePath: string
  providerSecretsDir: string
} {
  const cwdHash = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  const harnessRoot = runtimePath(runtimeId, extensionsRoot, '.cate-t3')
  const instancesRoot = runtimePath(runtimeId, harnessRoot, 'instances')
  return {
    harnessRoot,
    instancesRoot,
    baseDir: runtimePath(runtimeId, instancesRoot, cwdHash),
    providerProfilePath: runtimePath(runtimeId, harnessRoot, 'provider-profile.json'),
    providerSecretsDir: runtimePath(runtimeId, harnessRoot, 'provider-secrets'),
  }
}
