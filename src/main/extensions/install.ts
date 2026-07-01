// =============================================================================
// Extension host provisioning — place an extension's bytes ON the host that owns
// the workspace (local OR remote) and return its host-absolute root dir. This is
// the single, branch-free install path: everything downstream (static serving,
// server spawn) reads/runs from a runtime-host dir via runtime.file.* /
// runtime.server.*, with no isLocal special-case.
//
//   catalog : client stages the verified .tgz (download.ts), then — through the
//             runtime daemon — uploads it and extracts host-side into
//             ~/.cate/extensions/<id>/<version>. Idempotent via the host .ok
//             marker, so the bytes are uploaded at most once per host+version.
//   sideload: LOCAL shares the client fs (served in place); a remote host can't
//             see the dev folder, so the folder is uploaded to the host.
//
// Local is NOT a shortcut here — the LOCAL daemon is just another host reached
// over the runtime, so the same writeBinary/extract path runs for it too.
// =============================================================================

import path from 'path'
import { readFile } from 'fs/promises'
import log from '../logger'
import { LOCAL_RUNTIME_ID } from '../runtime/locator'
import type { Runtime } from '../runtime/types'
import { uploadEntriesToRuntime } from '../runtime/uploadEntries'
import { stageArtifact } from './download'
import type { CatalogEntry } from './catalog'

/** Join a path on the runtime HOST: native for LOCAL (client == host, same OS),
 *  posix for remote daemons (Linux/WSL hosts the daemon runs on). */
function hostJoin(runtime: Runtime, ...parts: string[]): string {
  return runtime.id === LOCAL_RUNTIME_ID ? path.join(...parts) : path.posix.join(...parts)
}

/**
 * Provision a catalog extension onto `runtime` and return its host-absolute root
 * dir (~/.cate/extensions/<id>/<version>). Stages the artifact on the client
 * (download + sha256 verify), then uploads the .tgz to the host and extracts it
 * there. Idempotent: when the host already has the extracted dir (.ok marker)
 * the bytes are NOT re-uploaded (cheap stat probe first), unless `force`.
 */
export async function provisionCatalogToRuntime(
  runtime: Runtime,
  entry: CatalogEntry,
  force = false,
): Promise<string> {
  const { id, version, tgzPath } = await stageArtifact(entry, force)
  const extRoot = await runtime.file.extensionsRoot()
  const dest = hostJoin(runtime, extRoot, id, version)

  if (!force) {
    const installed = await runtime.file
      .stat(hostJoin(runtime, dest, '.ok'))
      .then(() => true)
      .catch(() => false)
    if (installed) return dest
  }

  const bytes = await readFile(tgzPath)
  // The staged .tgz lands beside its dest dir, under the (allowed) extensions
  // root; extractArtifact validates + untars it and removes it. Appending '.tgz'
  // needs no path join, so it's separator-agnostic across host OSes.
  const hostTgz = `${dest}.tgz`
  await runtime.file.writeBinary(hostTgz, bytes)
  await runtime.file.extractArtifact(hostTgz, dest)
  log.info('[extensions] provisioned %s@%s to runtime %s -> %s', id, version, runtime.id, dest)
  return dest
}

/**
 * Provision a sideload (dev folder) extension onto `runtime` and return its
 * host-absolute root dir. LOCAL shares the client filesystem, so the folder is
 * served in place. A remote host can't see the client folder, so it's uploaded
 * to ~/.cate/extensions/<id>/sideload (replaced each time so dev edits land).
 */
export async function provisionSideloadToRuntime(
  runtime: Runtime,
  extensionId: string,
  folder: string,
): Promise<string> {
  if (runtime.id === LOCAL_RUNTIME_ID) return folder

  const extRoot = await runtime.file.extensionsRoot()
  const dest = hostJoin(runtime, extRoot, extensionId, 'sideload')
  // Replace any prior upload so dev edits propagate on re-provision.
  await runtime.file.remove(dest).catch(() => {})
  await runtime.file.mkdir(dest)
  const { created, failed } = await uploadEntriesToRuntime(runtime, [folder], dest, 'copy')
  if (failed > 0 || created.length === 0) {
    throw new Error(`sideload upload failed for ${extensionId}`)
  }
  log.info('[extensions] provisioned sideload %s to runtime %s -> %s', extensionId, runtime.id, created[0])
  return created[0]
}
