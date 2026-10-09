import { promises as fs } from 'node:fs'
import { writeJsonAtomic } from '@kernel/state/node'
import type { RuntimeInfo } from '../contract'
import { dataPaths } from './paths'

export async function writeRuntimeInfo(dataDir: string, info: RuntimeInfo): Promise<void> {
  await writeJsonAtomic(dataPaths(dataDir).runtimeInfo, info, { mode: 0o600 })
}

export async function readRuntimeInfo(dataDir: string): Promise<RuntimeInfo | undefined> {
  try {
    return JSON.parse(await fs.readFile(dataPaths(dataDir).runtimeInfo, 'utf8')) as RuntimeInfo
  } catch {
    return undefined
  }
}
