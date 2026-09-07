import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { patchT3Changes } from './patch-t3-changes.mjs'

describe('T3 reported change bridge', () => {
  it('is pinned, idempotent, and substitutes recorded summaries for checkout summaries', () => {
    const source = patchT3Changes(readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8'))
    expect(patchT3Changes(source)).toBe(source)
    expect(source.includes('yield* promise(() => cateReportChange(event))')).toBe(false)
    expect(source).toContain('process.env.CATE_CHANGES_ENDPOINT ? yield* promise(() => cateChangeSummary(input.threadId, input.turnId))')
    expect(() => patchT3Changes('upstream changed')).toThrow('ingestion seam changed')
  })

  it('waits for persistence before reading the summary and never falls back after capture failure', async () => {
    const source = patchT3Changes(readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8'))
    const helper = source.slice(source.indexOf('/* cate: agent change ingestion v1 */'))
    const order = []
    const fetch = vi.fn(async (url) => { order.push(url); return { ok: true, json: async () => url.endsWith('/summary') ? [{ path: 'a.ts' }] : [] } })
    const context = { process: { env: { CATE_CHANGES_ENDPOINT: 'http://host', CATE_CHANGES_TOKEN: 'token', CATE_CHANGES_SOURCE: 'source' } }, fetch, AbortSignal, setTimeout, console: { warn: vi.fn() } }
    const result = await runInNewContext(helper + ';cateReportChange({type:"turn.diff.updated",threadId:"chat",turnId:"turn"});cateChangeSummary("chat","turn")', context)
    expect(order).toEqual(['http://host/t3-changes', 'http://host/t3-changes/summary'])
    expect(result).toEqual([{ path: 'a.ts' }])
    fetch.mockRejectedValue(new Error('offline'))
    expect(await runInNewContext('cateChangeSummary("chat","turn")', context)).toEqual([])
  })

  it('keeps ingestion and other turns responsive while a capture request is pending', async () => {
    const source = patchT3Changes(readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8'))
    let release
    const fetch = vi.fn((url, init) => {
      const body = JSON.parse(init.body)
      if (body.payload?.threadId === 'slow') return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => [] }) })
      return Promise.resolve({ ok: true, json: async () => [] })
    })
    const context = { process: { env: {} }, fetch, AbortSignal, setTimeout, console: { warn: vi.fn() } }
    const result = runInNewContext(source.slice(source.indexOf('/* cate: agent change ingestion v1 */')) + ';cateReportChange({type:"turn.diff.updated",threadId:"slow",turnId:"1"})', context)
    expect(result).toBeUndefined()
    await runInNewContext('cateReportChange({type:"turn.diff.updated",threadId:"fast",turnId:"2"});cateChangeSummary("fast","2")', context)
    expect(fetch.mock.calls.some(([, init]) => JSON.parse(init.body).threadId === 'fast')).toBe(true)
    release()
  })

  it('retries transient failures before summarizing and skips non-edit message completions', async () => {
    const source = patchT3Changes(readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8'))
    const fetch = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({ ok: true, json: async () => [] })
    const context = { process: { env: {} }, fetch, AbortSignal, setTimeout: (fn) => fn(), console: { warn: vi.fn() } }
    await runInNewContext(source.slice(source.indexOf('/* cate: agent change ingestion v1 */')) + ';cateReportChange({type:"item.completed",payload:{itemType:"assistant_message",status:"completed"},threadId:"chat",turnId:"turn"});cateReportChange({type:"turn.diff.updated",threadId:"chat",turnId:"turn"});cateChangeSummary("chat","turn")', context)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.slice(0, 2).map(([, init]) => JSON.parse(init.body).payload.type)).toEqual(['turn.diff.updated', 'turn.diff.updated'])
  })

  it('bounds backlog and concurrency while retaining accepted events in turn order', async () => {
    const source = patchT3Changes(readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8'))
    const releases = []
    const seen = []
    const fetch = vi.fn((_url, init) => new Promise((resolve) => {
      seen.push(JSON.parse(init.body).payload.eventId)
      releases.push(() => resolve({ ok: true, json: async () => [] }))
    }))
    const warn = vi.fn()
    const context = { process: { env: {} }, fetch, AbortSignal, setTimeout, console: { warn } }
    runInNewContext(source.slice(source.indexOf('/* cate: agent change ingestion v1 */')) + ';for(let i=0;i<257;i++)cateReportChange({type:"turn.diff.updated",threadId:String(i%8),turnId:"turn",eventId:i})', context)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('queue full'))
    for (let completed = 0; completed < 256;) {
      for (const release of releases.splice(0)) { release(); completed++ }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(seen).toHaveLength(256)
    for (let thread = 0; thread < 8; thread++) expect(seen.filter((id) => id % 8 === thread)).toEqual(Array.from({ length: 32 }, (_, i) => thread + i * 8))
  })

  it('reports exhausted retries and allows later events to recover', async () => {
    const source = patchT3Changes(readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8'))
    const fetch = vi.fn().mockRejectedValue(new Error('offline'))
    const warn = vi.fn()
    const context = { process: { env: {} }, fetch, AbortSignal, setTimeout: (fn) => fn(), console: { warn } }
    await runInNewContext(source.slice(source.indexOf('/* cate: agent change ingestion v1 */')) + ';cateReportChange({type:"turn.diff.updated",threadId:"chat",turnId:"turn"});cateChangeSummary("chat","turn")', context)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed after retries'), 'offline')
    fetch.mockResolvedValue({ ok: true, json: async () => [{ path: 'recovered.ts' }] })
    expect(await runInNewContext('cateReportChange({type:"turn.diff.updated",threadId:"chat",turnId:"turn"});cateChangeSummary("chat","turn")', context)).toEqual([{ path: 'recovered.ts' }])
  })
})
