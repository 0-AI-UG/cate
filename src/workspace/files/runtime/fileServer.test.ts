import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeWorkspace } from '../testing.test-helpers'
import { decodeServedPath, encodeServedPath } from './fileServer'

let ws: Awaited<ReturnType<typeof makeWorkspace>>
let dir: string
let root: string
// Through the `file.serveUrl` capability, as a client asks.
let files: { serveUrl(p: string): Promise<string> }
let trusted: boolean
beforeEach(async () => {
  trusted = true
  ws = await makeWorkspace({ trust: { isTrusted: () => trusted, requireTrusted: () => {} } })
  dir = ws.base
  root = ws.root
  await fs.mkdir(path.join(root, 'site', 'css'), { recursive: true })
  await fs.writeFile(path.join(root, 'site', 'index.html'), '<link href="css/a b.css">')
  await fs.writeFile(path.join(root, 'site', 'css', 'a b.css'), 'body{}')
  await fs.writeFile(path.join(dir, 'secret.txt'), 'nope')
  await fs.writeFile(path.join(root, '.env'), 'KEY=1')
  await fs.writeFile(path.join(root, 'site', 'logo.svg'), '<svg/>')
  files = (await ws.connect()).fs
})
afterEach(async () => {
  await ws.dispose()
})

describe('file server', () => {
  it('serves a workspace file on 127.0.0.1 with its token and a content type', async () => {
    const url = await files.serveUrl(path.join(root, 'site', 'index.html'))
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}\//)
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe('<link href="css/a b.css">')
  })

  it('resolves relative links against the served URL', async () => {
    const page = await files.serveUrl(path.join(root, 'site', 'index.html'))
    const res = await fetch(new URL('css/a b.css', page))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await res.text()).toBe('body{}')
  })

  it('serves index.html for a directory', async () => {
    const res = await fetch(await files.serveUrl(path.join(root, 'site')))
    expect(await res.text()).toBe('<link href="css/a b.css">')
  })

  it('rejects a wrong token', async () => {
    const url = new URL(await files.serveUrl(path.join(root, 'site', 'index.html')))
    url.pathname = url.pathname.replace(/^\/[0-9a-f]+\//, '/0000/')
    expect((await fetch(url)).status).toBe(404)
  })

  it('rejects paths outside the scope, also through .. segments', async () => {
    await expect(files.serveUrl(path.join(dir, 'secret.txt'))).rejects.toThrow(/outside the workspace/)
    const page = new URL(await files.serveUrl(path.join(root, 'site', 'index.html')))
    const token = page.pathname.split('/')[1]
    const outside = `${page.origin}/${token}/${encodeServedPath(path.join(dir, 'secret.txt'))}`
    expect((await fetch(outside)).status).toBe(404)
    const dotted = `${page.origin}/${token}/${encodeServedPath(root)}/%2E%2E/secret.txt`
    expect((await fetch(dotted)).status).toBe(404)
  })

  it('binds a token to the served file\'s folder', async () => {
    const page = new URL(await files.serveUrl(path.join(root, 'site', 'index.html')))
    const token = page.pathname.split('/')[1]
    const at = (p: string) => `${page.origin}/${token}/${p}`
    // A page cannot climb out of its folder to the rest of the workspace.
    expect((await fetch(at(encodeServedPath(path.join(root, '.env'))))).status).toBe(404)
    expect((await fetch(at(`${encodeServedPath(path.join(root, 'site'))}/%2E%2E/.env`))).status).toBe(404)
    expect((await fetch(at(`${encodeServedPath(path.join(root, 'site'))}%2F..%2F.env`))).status).toBe(404)
    expect((await fetch(at(`${encodeServedPath(path.join(root, 'site'))}-x/a`))).status).toBe(404)
    // Nor through a symlink inside it.
    await fs.symlink(path.join(root, '.env'), path.join(root, 'site', 'env.txt'))
    expect((await fetch(new URL('env.txt', page))).status).toBe(404)
    // The same folder reuses its token; another folder gets its own.
    expect(new URL(await files.serveUrl(path.join(root, 'site', 'css', 'a b.css'))).pathname.split('/')[1]).not.toBe(token)
    expect(new URL(await files.serveUrl(path.join(root, 'site', 'logo.svg'))).pathname.split('/')[1]).toBe(token)
  })

  it('serves pages that run script as plain text while the workspace is untrusted', async () => {
    trusted = false
    const page = await files.serveUrl(path.join(root, 'site', 'index.html'))
    let res = await fetch(page)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await fetch(new URL('logo.svg', page))).headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect((await fetch(new URL('css/a b.css', page))).headers.get('content-type')).toBe('text/css; charset=utf-8')
    trusted = true
    res = await fetch(page)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('never serves the workspace data, which the file capability itself may read', async () => {
    await fs.writeFile(path.join(ws.data, 'secrets.json'), '{"key":"x"}')
    await expect(files.serveUrl(path.join(ws.data, 'secrets.json'))).rejects.toThrow()
    const page = new URL(await files.serveUrl(path.join(root, 'site', 'index.html')))
    const token = page.pathname.split('/')[1]
    const res = await fetch(`${page.origin}/${token}/${encodeServedPath(path.join(ws.data, 'secrets.json'))}`)
    expect(res.status).toBe(404)
  })

  it('404s a missing file', async () => {
    const page = await files.serveUrl(path.join(root, 'site', 'index.html'))
    expect((await fetch(new URL('missing.html', page))).status).toBe(404)
  })
})

describe('served paths', () => {
  it('round-trips POSIX and Windows paths', () => {
    expect(encodeServedPath('/a/b c#.html')).toBe('a/b%20c%23.html')
    expect(decodeServedPath('a/b%20c%23.html')).toBe('/a/b c#.html')
    expect(encodeServedPath('C:\\a\\b.html')).toBe('C%3A/a/b.html')
    expect(decodeServedPath('C%3A/a/b.html')).toBe('C:/a/b.html')
  })
})
