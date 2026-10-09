import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallContext, StreamSink } from '@kernel/rpc/runtime'
import { openSecretsFile, dataPaths } from '@runtime/data/runtime'
import type { BrowserDownloadEntry, BrowserUploadHeader } from '../contract'
import { browserDataCapabilityImpl, createBrowserDataRuntime, type BrowserDataRuntime } from './browserData'
import { authorizeUpload } from './upload'

let dir: string
let service: BrowserDataRuntime
let secrets: ReturnType<typeof openSecretsFile>

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-browser-data-')))
  secrets = openSecretsFile(dir)
  secrets.load()
  service = createBrowserDataRuntime({
    dataPaths: dataPaths(dir),
    secrets,
    paths: {
      validate: (p) => {
        const resolved = path.resolve(dir, p)
        if (!resolved.startsWith(dir + path.sep)) throw new Error(`Access denied: ${p}`)
        return resolved
      },
    },
  })
})
afterEach(async () => {
  service.dispose()
  secrets.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

function fakeSink<E>() {
  const events: E[] = []
  const chunks: Uint8Array[] = []
  let ended = false
  let failed: unknown
  const sink: StreamSink<E, void> = {
    emit: (e) => { events.push(e) },
    bytes: (b) => { chunks.push(b); return true },
    drain: async () => {},
    onInput: () => {},
    end: () => { ended = true },
    fail: (err) => { failed = err; ended = true },
    get ended() { return ended },
  }
  return { sink, events, chunks, get failed() { return failed } }
}
const ctx = { signal: new AbortController().signal } as CallContext

const entry = (id: string, state: BrowserDownloadEntry['state'], at: number): BrowserDownloadEntry => ({
  id, url: `https://x/${id}`, filename: `${id}.zip`, filePath: `/d/${id}.zip`, state, receivedBytes: 0, totalBytes: 0, at,
})

describe('downloads', () => {
  it('keeps the last 20 completed downloads per panel and every active one', () => {
    for (let i = 0; i < 25; i += 1) service.downloads.record('p1', entry(`c${i}`, 'completed', i))
    service.downloads.record('p1', entry('live', 'progressing', 0))
    const list = service.downloads.list('p1')
    expect(list).toHaveLength(21)
    expect(list.some((e) => e.id === 'c0')).toBe(false)
    expect(list.some((e) => e.id === 'live')).toBe(true)
    expect(service.downloads.list('p2')).toEqual([])
  })

  it('streams a snapshot, then every change, and resolves the downloads dir', async () => {
    const impl = browserDataCapabilityImpl(service)
    const { sink, events } = fakeSink<BrowserDownloadEntry[]>()
    const stop = impl.watchDownloads({ panelId: 'p1' }, sink, ctx)
    await impl.recordDownload({ panelId: 'p1', entry: entry('a', 'progressing', 1) }, ctx)
    await impl.recordDownload({ panelId: 'p1', entry: entry('a', 'completed', 1) }, ctx)
    await impl.removeDownload({ panelId: 'p1', id: 'a' }, ctx)
    if (typeof stop === 'function') stop()
    expect(events.map((list) => list.map((e) => e.state))).toEqual([[], ['progressing'], ['completed'], []])
    const downloadsDir = await impl.downloadsDir(undefined, ctx)
    expect(downloadsDir).toBe(path.join(dir, 'browser', 'downloads'))
    expect((await fs.stat(downloadsDir)).isDirectory()).toBe(true)
  })
})

describe('uploads', () => {
  it('streams an authorized host file to the client', async () => {
    await fs.writeFile(path.join(dir, 'report.pdf'), 'pdf-bytes')
    const impl = browserDataCapabilityImpl(service)
    const out = fakeSink<BrowserUploadHeader>()
    await impl.upload({ path: 'report.pdf' }, out.sink, ctx)
    expect(out.events).toEqual([{ name: 'report.pdf', size: 9 }])
    expect(Buffer.concat(out.chunks).toString()).toBe('pdf-bytes')
    expect(out.sink.ended).toBe(true)
  })

  it('hides denied host paths behind a stable error', async () => {
    await expect(authorizeUpload(service.paths, '/secret')).rejects.toThrow('browser-upload-path-denied')
  })

  it('rejects directories and missing paths', async () => {
    await fs.mkdir(path.join(dir, 'folder'))
    await expect(authorizeUpload(service.paths, 'folder')).rejects.toThrow('browser-upload-file-required')
    await expect(authorizeUpload(service.paths, '')).rejects.toThrow('browser-upload-file-required')
  })
})
