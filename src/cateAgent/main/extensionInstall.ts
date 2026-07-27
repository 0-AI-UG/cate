// =============================================================================
// extensionInstall — shared utilities for seeding bundled extensions into a
// workspace's cate-agent dir.
//
// The SOURCE bundle is always read locally with node fs (it ships inside the
// app). Each DESTINATION is written THROUGH the runtime (local fs for the
// local runtime, the daemon for a remote one), so remote workspaces are
// seeded too.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostCodingDir, hostJoin } from './codingDir'
import type { Runtime } from '../../main/runtime/types'

/** Install-once gate keyed on an arbitrary string. */
export interface IdempotencyTracker {
  /** True when `key` has not been installed yet (and should be installed now). */
  shouldInstall(key: string): boolean
  /** Record `key` as installed so a later shouldInstall() returns false. */
  markInstalled(key: string): void
}

/** Create a fresh idempotency tracker backed by an in-memory Set. */
export function createIdempotencyTracker(): IdempotencyTracker {
  const installed = new Set<string>()
  return {
    shouldInstall: (key) => !installed.has(key),
    markInstalled: (key) => { installed.add(key) },
  }
}

/** Source dir of a bundled extension. Returns the first candidate path that
 *  exists on disk (dev path first, production extraResources copy second), or
 *  null when none are present. */
export function findSourceDir(candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

/**
 * Build an installer for a Cate-managed extension bundled as index.ts +
 * package.json. Concurrent sessions share one in-flight copy, successful
 * installs are skipped thereafter, and transient failures remain retryable.
 */
export function createBundledExtensionInstaller(
  slug: string,
  logLabel: string,
): (runtime: Runtime, cwd: string) => Promise<void> {
  const installed = new Set<string>()
  const pending = new Map<string, Promise<void>>()

  return async (runtime: Runtime, cwd: string): Promise<void> => {
    const home = hostCodingDir(runtime.id, cwd)
    const key = `${runtime.id}\0${home}`
    if (installed.has(key)) return
    const existing = pending.get(key)
    if (existing) return existing

    const install = (async () => {
      const src = findSourceDir([
        path.join(app.getAppPath(), 'src', 'cateAgent', 'extensions', slug),
        path.join(process.resourcesPath ?? '', 'cate-extensions', slug),
      ])
      if (!src) throw new Error(`bundled source directory not found for ${slug}`)
      const destDir = hostJoin(runtime.id, home, 'extensions', slug)
      await copyFileToHost(runtime, path.join(src, 'index.ts'), destDir, 'index.ts', 'if-changed', logLabel)
      await copyFileToHost(runtime, path.join(src, 'package.json'), destDir, 'package.json', 'if-changed', logLabel)
      installed.add(key)
    })()
    pending.set(key, install)
    try {
      await install
    } catch (err) {
      log.warn('%s install failed: %O', logLabel, err)
    } finally {
      pending.delete(key)
    }
  }
}

/** True when the host already has a file/dir at `hostPath`. */
export async function hostFileExists(runtime: Runtime, hostPath: string): Promise<boolean> {
  try {
    await runtime.file.stat(hostPath)
    return true
  } catch {
    return false
  }
}

/** Copy a single source file (read locally) to a host destination.
 *
 *  Overwrite semantics depend on `overwrite`:
 *   - 'if-changed': rewrite only when the host copy differs from the bundled
 *     source (Cate-managed files where the bundle is authoritative — comparing
 *     first still skips the write when nothing changed, but a shipped update
 *     reliably reaches hosts that already have an older copy).
 *   - 'if-missing': skip entirely when the host already has the file, so a
 *     user's modified copy is never overwritten. */
export async function copyFileToHost(
  runtime: Runtime,
  src: string,
  destDir: string,
  destName: string,
  overwrite: 'if-changed' | 'if-missing',
  logLabel: string,
): Promise<void> {
  const dest = hostJoin(runtime.id, destDir, destName)
  if (overwrite === 'if-missing' && (await hostFileExists(runtime, dest))) {
    return // leave the user's copy alone
  }
  let contents: string
  try { contents = await fsp.readFile(src, 'utf-8') }
  catch { return } // source missing — nothing to copy
  if (overwrite === 'if-changed' && (await hostFileExists(runtime, dest))) {
    try {
      const existing = await runtime.file.readFile(dest)
      if (existing === contents) return // up to date — nothing to do
    } catch { /* unreadable — fall through and rewrite */ }
  }
  await runtime.file.mkdir(destDir)
  await runtime.file.writeFile(dest, contents)
  log.info('%s installed %s', logLabel, dest)
}
