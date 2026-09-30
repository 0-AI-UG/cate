// T3's own files in the workspace's t3 root: each instance's settings and
// provider secrets, and the workspace provider profile shared by instances.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from '@kernel/state/node'
import {
  applyCateProviderDefaults,
  applyProviderProfile,
  enforceCateSettings,
  extractProviderProfile,
  isProviderSecretFile,
} from '../contract'
import type { T3Paths } from './paths'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

export async function readJsonObject(file: string, label: string): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (error) {
    if (isMissing(error)) return null
    throw new Error(`Cannot read ${label}: ${errorMessage(error)}`)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be a JSON object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${errorMessage(error)}`)
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

/** Replaces the provider secret files of `targetDir` with those of `sourceDir`.
 *  Secret files stay 0600. */
async function copyProviderSecrets(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 })
  for (const name of await listFiles(targetDir)) {
    if (isProviderSecretFile(name)) await fs.rm(path.join(targetDir, name), { force: true })
  }
  for (const name of await listFiles(sourceDir)) {
    if (!isProviderSecretFile(name)) continue
    const target = path.join(targetDir, name)
    await fs.copyFile(path.join(sourceDir, name), target)
    await fs.chmod(target, 0o600)
  }
}

/** Brings an instance's T3 settings in line with the workspace provider
 *  profile and Cate's enforced settings. Runs before the harness starts. */
export async function prepareInstanceSettings(paths: T3Paths): Promise<void> {
  await fs.mkdir(paths.userdata, { recursive: true, mode: 0o700 })
  const settings = await readJsonObject(paths.settings, 'T3 settings') ?? {}
  let next = settings
  const profile = await readJsonObject(paths.providerProfile, 'T3 provider profile')
  if (profile) {
    await copyProviderSecrets(paths.providerSecrets, paths.secrets)
    next = applyProviderProfile(settings, profile)
  }
  next = enforceCateSettings(applyCateProviderDefaults(next))
  if (JSON.stringify(next) === JSON.stringify(settings)) return
  await writeJsonAtomic(paths.settings, next, { mode: 0o600 })
}

/** Publishes the provider part of an instance's settings, and its provider
 *  secrets, as the workspace profile. False when the instance has no settings. */
export async function publishProviderProfile(paths: T3Paths): Promise<boolean> {
  const settings = await readJsonObject(paths.settings, 'T3 settings')
  if (!settings) return false
  await copyProviderSecrets(paths.secrets, paths.providerSecrets)
  await writeJsonAtomic(paths.providerProfile, extractProviderProfile(settings), { mode: 0o600 })
  return true
}
