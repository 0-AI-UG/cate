import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildDaemonRuntime } from './index'
import { assertSafeMemberName, hostExtensionsRoot } from './extensions'

// -- Hand-rolled ustar tgz writer -------------------------------------------
// Real `tar` won't let us store a member whose name literally contains `..`
// segments or an absolute path, so we craft the archive bytes directly. This is
// a minimal ustar (POSIX) tar of regular-file members, gzipped with zlib — no
// deps. It lets us prove extractArtifact rejects hostile member NAMES (including
// ones with spaces) before anything escapes.
type TarMember = { name: string; content?: string }

function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512, 0)
  buf.write(name, 0, 100, 'utf8')
  buf.write('0000644\0', 100) // mode
  buf.write('0000000\0', 108) // uid
  buf.write('0000000\0', 116) // gid
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124) // size
  buf.write('00000000000\0', 136) // mtime
  buf.write('        ', 148) // checksum placeholder (8 spaces)
  buf.write('0', 156) // typeflag: regular file
  buf.write('ustar\0', 257)
  buf.write('00', 263)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148) // checksum
  return buf
}

async function writeMaliciousTgz(tgzPath: string, members: TarMember[]): Promise<void> {
  const chunks: Buffer[] = []
  for (const m of members) {
    const content = Buffer.from(m.content ?? '', 'utf8')
    chunks.push(tarHeader(m.name, content.length))
    chunks.push(content)
    const pad = (512 - (content.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(1024, 0)) // two zero blocks = end of archive
  await fs.writeFile(tgzPath, zlib.gzipSync(Buffer.concat(chunks)))
}
const MANIFEST = JSON.stringify({ id: 'acme.example', name: 'Example', panels: [] })
import { addAllowedRoot, removeAllowedRoot } from '../../main/ipc/pathValidation'
import type { Runtime } from '../../main/runtime/types'

const execFileAsync = promisify(execFile)

// extractArtifact runs host-side through the daemon FileHost: the .tgz (already
// written via writeBinary and verified client-side) is validated for unsafe
// members, untarred into a versioned dir, and marked with .ok. Drive it through
// buildDaemonRuntime so the path-validation wrapper is exercised too.
describe('daemon FileHost extension install', () => {
  let root: string
  let runtime: Runtime

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-ext-install-')))
    addAllowedRoot(root)
    runtime = buildDaemonRuntime({ id: 'test' }).runtime
  })

  afterEach(async () => {
    removeAllowedRoot(root)
    await fs.rm(root, { recursive: true, force: true })
  })

  /** Build a .tgz from a freshly-staged extension dir, returning its path. */
  async function makeTarball(name: string, extra?: (stageDir: string) => Promise<void>): Promise<string> {
    const stage = path.join(root, `stage-${name}`)
    await fs.mkdir(stage, { recursive: true })
    await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ id: 'acme.example', name: 'Example', panels: [] }))
    await fs.writeFile(path.join(stage, 'index.html'), '<!doctype html><title>hi</title>')
    await extra?.(stage)
    const tgz = path.join(root, `${name}.tgz`)
    await execFileAsync('tar', ['-czf', tgz, '-C', stage, '.'])
    return tgz
  }

  test('extensionsRoot resolves to the host ~/.cate/extensions', async () => {
    expect(await runtime.file.extensionsRoot()).toBe(hostExtensionsRoot())
    expect(hostExtensionsRoot()).toBe(path.join(os.homedir(), '.cate', 'extensions'))
  })

  test('extractArtifact untars into dest, writes .ok, removes the tgz', async () => {
    const tgz = await makeTarball('ok')
    const dest = path.join(root, 'acme.example', '1.0.0')

    const result = await runtime.file.extractArtifact(tgz, dest)

    expect(result).toBe(dest)
    expect(existsSync(path.join(dest, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(dest, 'index.html'))).toBe(true)
    expect(existsSync(path.join(dest, '.ok'))).toBe(true)
    // The tgz is consumed.
    expect(existsSync(tgz)).toBe(false)
    // The extracted bytes are readable back through the runtime file host.
    expect(await runtime.file.readFile(path.join(dest, 'index.html'))).toContain('<title>hi</title>')
  })

  test('extractArtifact rejects a tarball missing manifest.json', async () => {
    const stage = path.join(root, 'stage-nomani')
    await fs.mkdir(stage, { recursive: true })
    await fs.writeFile(path.join(stage, 'index.html'), 'x')
    const tgz = path.join(root, 'nomani.tgz')
    await execFileAsync('tar', ['-czf', tgz, '-C', stage, '.'])

    await expect(runtime.file.extractArtifact(tgz, path.join(root, 'out'))).rejects.toThrow(/manifest\.json/)
    expect(existsSync(path.join(root, 'out'))).toBe(false)
  })

  // A symlink member could redirect a later write outside the dir; the host-side
  // safe-tarball check must reject it before extraction.
  test.skipIf(process.platform === 'win32')('extractArtifact rejects a tarball with a symlink member', async () => {
    const tgz = await makeTarball('evil', async (stage) => {
      await fs.symlink('/etc/passwd', path.join(stage, 'link'))
    })
    await expect(runtime.file.extractArtifact(tgz, path.join(root, 'evil-out'))).rejects.toThrow(/unsafe tar entry/)
    expect(existsSync(path.join(root, 'evil-out'))).toBe(false)
  })

  // A `..`-traversal member must be rejected — including one whose name contains
  // a SPACE ("a b/../../evil"), which the old last-whitespace-field parse would
  // have reduced to "evil" and let through, then written outside the temp dir.
  test('extractArtifact rejects a tarball with a spaced ..-traversal member', async () => {
    const tgz = path.join(root, 'traversal.tgz')
    await writeMaliciousTgz(tgz, [
      { name: 'manifest.json', content: MANIFEST },
      { name: 'a b/../../evil', content: 'pwned' },
    ])
    const dest = path.join(root, 'acme.example', '1.0.0')
    // Where the escaping member would have landed (sibling of the temp dir).
    const escaped = path.join(root, 'acme.example', 'evil')

    await expect(runtime.file.extractArtifact(tgz, dest)).rejects.toThrow(/unsafe tar entry/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(escaped)).toBe(false)
  })

  test('extractArtifact rejects a tarball with an absolute-path member', async () => {
    const tgz = path.join(root, 'absolute.tgz')
    const absTarget = path.join(root, 'abs-evil')
    await writeMaliciousTgz(tgz, [
      { name: 'manifest.json', content: MANIFEST },
      { name: absTarget, content: 'pwned' },
    ])
    await expect(runtime.file.extractArtifact(tgz, path.join(root, 'abs-out'))).rejects.toThrow(
      /unsafe tar entry/,
    )
    expect(existsSync(path.join(root, 'abs-out'))).toBe(false)
    expect(existsSync(absTarget)).toBe(false)
  })

  test('assertSafeMemberName rejects traversal/absolute, accepts normal names', () => {
    for (const bad of ['../evil', 'a b/../../evil', '..', 'foo/../bar', '/etc/passwd', '/tmp/x']) {
      expect(() => assertSafeMemberName(bad)).toThrow(/unsafe tar entry/)
    }
    for (const ok of ['manifest.json', './index.html', 'sub/dir/file.js', './', 'a..b/c']) {
      expect(() => assertSafeMemberName(ok)).not.toThrow()
    }
  })

  test('extractArtifact rejects a dest outside any allowed root', async () => {
    const tgz = await makeTarball('outside')
    const outside = path.join(os.homedir(), 'cate-ext-should-not-extract')
    await expect(runtime.file.extractArtifact(tgz, outside)).rejects.toThrow(
      /Access denied|outside allowed directories/,
    )
    expect(existsSync(outside)).toBe(false)
  })
})
