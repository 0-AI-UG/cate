import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

const h = vi.hoisted(() => ({ userData: '', appPath: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getAppPath: () => h.appPath },
}))

// download.ts now STAGES the verified .tgz on the client (no extraction); the
// host (local OR remote daemon) extracts it via file.extractArtifact. The
// safe-tarball / manifest checks therefore live host-side and are covered by
// runtime/capabilities/extensions.test.ts — here we only test fetch + verify +
// cache of the artifact bytes.
import {
  stageArtifact,
  isStaged,
  stagedTgzPath,
  stagedVersions,
  MAX_ARTIFACT_BYTES,
  ARTIFACT_FETCH_TIMEOUT_MS,
} from './download'
import { readCappedBytes, type CatalogEntry } from './catalog'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cate-download-'))
  h.userData = path.join(tmp, 'userData')
  h.appPath = tmp
  mkdirSync(h.userData, { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Build a hello.tgz from a minimal extension folder; return file path + sha256. */
function buildArtifact(id = 'cate.hello', version = '0.1.0'): { file: string; sha256: string } {
  const srcDir = path.join(tmp, 'ext-src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(
    path.join(srcDir, 'manifest.json'),
    JSON.stringify({ id, name: 'Hello', version, panels: [{ id: 'main', label: 'Hello' }], frontend: 'index.html' }),
  )
  writeFileSync(path.join(srcDir, 'index.html'), '<!doctype html><h1>hi</h1>')
  const file = path.join(tmp, `${id}-${version}.tgz`)
  execFileSync('tar', ['-czf', file, '-C', srcDir, '.'])
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
  return { file, sha256 }
}

function entryFor(file: string, sha256?: string, id = 'cate.hello', version = '0.1.0'): CatalogEntry {
  return {
    manifest: { id, name: 'Hello', version, panels: [{ id: 'main', label: 'Hello' }] },
    artifactUrl: pathToFileURL(file).toString(),
    sha256,
    // Represents an entry that came from a local (file:// / absolute) catalog
    // source — the only case exempt from the http(s) + sha256 requirement.
    sourceIsLocal: true,
  }
}

describe('stageArtifact', () => {
  it('downloads + caches a local file:// artifact as a verified .tgz', async () => {
    const { file } = buildArtifact()
    const { id, version, tgzPath } = await stageArtifact(entryFor(file))
    expect(id).toBe('cate.hello')
    expect(version).toBe('0.1.0')
    expect(tgzPath).toBe(stagedTgzPath('cate.hello', '0.1.0'))
    expect(existsSync(tgzPath)).toBe(true)
    expect(isStaged('cate.hello', '0.1.0')).toBe(true)
    expect(await stagedVersions('cate.hello')).toEqual(['0.1.0'])
    // The cached bytes are the artifact bytes (so any host can extract them).
    expect(readFileSync(tgzPath).equals(readFileSync(file))).toBe(true)
  })

  it('is idempotent: a second stage short-circuits on the cached .tgz', async () => {
    const { file } = buildArtifact()
    const entry = entryFor(file)
    const first = await stageArtifact(entry)
    // Removing the source artifact proves the second call does no re-download.
    rmSync(file)
    const second = await stageArtifact(entry)
    expect(second.tgzPath).toBe(first.tgzPath)
    expect(isStaged('cate.hello', '0.1.0')).toBe(true)
  })

  it('verifies sha256 and stages when it matches', async () => {
    const { file, sha256 } = buildArtifact()
    const { tgzPath } = await stageArtifact(entryFor(file, sha256))
    expect(existsSync(tgzPath)).toBe(true)
  })

  it('throws on sha256 mismatch and leaves nothing staged', async () => {
    const { file } = buildArtifact()
    const bad = 'f'.repeat(64)
    await expect(stageArtifact(entryFor(file, bad))).rejects.toThrow(/sha256 mismatch/)
    expect(isStaged('cate.hello', '0.1.0')).toBe(false)
    expect(existsSync(stagedTgzPath('cate.hello', '0.1.0'))).toBe(false)
  })

  it('rejects a remote (https) artifact that is missing a sha256, without downloading', async () => {
    // No network call should happen — the missing-sha256 guard fires first. If
    // it didn't, fetch() to this host would throw a different error.
    const entry: CatalogEntry = {
      manifest: { id: 'cate.remote', name: 'Remote', version: '0.1.0', panels: [{ id: 'm', label: 'M' }] },
      artifactUrl: 'https://example.invalid/cate.remote-0.1.0.tgz',
    }
    await expect(stageArtifact(entry)).rejects.toThrow(/missing a required sha256/)
    expect(isStaged('cate.remote', '0.1.0')).toBe(false)
  })

  it('resolves a relative artifactUrl against the app path', async () => {
    const { file } = buildArtifact('cate.rel', '0.1.0')
    const rel = path.relative(h.appPath, file)
    const entry: CatalogEntry = {
      manifest: { id: 'cate.rel', name: 'Rel', version: '0.1.0', panels: [{ id: 'm', label: 'M' }] },
      artifactUrl: './' + rel,
      sourceIsLocal: true,
    }
    const { tgzPath } = await stageArtifact(entry)
    expect(existsSync(tgzPath)).toBe(true)
  })

  it('rejects a remote-sourced entry whose artifactUrl is not http(s)', async () => {
    // A hostile remote catalog can't point at a local-disk path to get an
    // unpinned, checksum-free read: a non-http artifactUrl from a remote source
    // (sourceIsLocal !== true) is refused before any fs/network access.
    const { file } = buildArtifact('cate.evil', '0.1.0')
    const entry: CatalogEntry = {
      manifest: { id: 'cate.evil', name: 'Evil', version: '0.1.0', panels: [{ id: 'm', label: 'M' }] },
      artifactUrl: file, // absolute local path, but the source is remote
      sha256: 'a'.repeat(64),
      sourceIsLocal: false,
    }
    await expect(stageArtifact(entry)).rejects.toThrow(/must use an http\(s\) artifactUrl/)
    expect(isStaged('cate.evil', '0.1.0')).toBe(false)
  })

  it('rejects a remote-sourced (http) entry missing a sha256', async () => {
    const entry: CatalogEntry = {
      manifest: { id: 'cate.rmt', name: 'Rmt', version: '0.1.0', panels: [{ id: 'm', label: 'M' }] },
      artifactUrl: 'https://example.invalid/cate.rmt-0.1.0.tgz',
      sourceIsLocal: false,
    }
    await expect(stageArtifact(entry)).rejects.toThrow(/missing a required sha256/)
    expect(isStaged('cate.rmt', '0.1.0')).toBe(false)
  })

  it('falls back to the artifactUrl scheme for an unflagged entry (legacy compat)', async () => {
    // Directly-constructed entries (dev/test) with no sourceIsLocal flag keep
    // the legacy behavior: a local-path artifactUrl is treated as a local dev
    // artifact and stages without a sha256. (Real entries are always flagged.)
    const { file } = buildArtifact('cate.legacy', '0.1.0')
    const entry: CatalogEntry = {
      manifest: { id: 'cate.legacy', name: 'Legacy', version: '0.1.0', panels: [{ id: 'm', label: 'M' }] },
      artifactUrl: pathToFileURL(file).toString(),
    }
    const { tgzPath } = await stageArtifact(entry)
    expect(existsSync(tgzPath)).toBe(true)
  })
})

describe('readCappedBytes', () => {
  it('returns the body bytes when under the cap', async () => {
    const res = new Response(new Uint8Array([1, 2, 3, 4]))
    const buf = await readCappedBytes(res, 100, 'test')
    expect(Buffer.from([1, 2, 3, 4]).equals(buf)).toBe(true)
  })

  it('throws once the body exceeds the cap', async () => {
    const res = new Response(new Uint8Array(1000))
    await expect(readCappedBytes(res, 100, 'test')).rejects.toThrow(/exceeds max size/)
  })

  it('exposes defensible artifact caps', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(256 * 1024 * 1024)
    expect(ARTIFACT_FETCH_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
