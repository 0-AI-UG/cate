import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { patchT3Changes } from './patch-t3-changes.mjs'

describe('T3 reported change bridge', () => {
  it('is pinned, idempotent, and substitutes recorded summaries for checkout summaries', () => {
    const source = patchT3Changes(readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8'))
    expect(patchT3Changes(source)).toBe(source)
    expect(source).toContain('yield* promise(() => cateReportChange(event))')
    expect(source).toContain('process.env.CATE_CHANGES_ENDPOINT ? yield* promise(() => cateChangeSummary(input.threadId, input.turnId))')
    expect(() => patchT3Changes('upstream changed')).toThrow('ingestion seam changed')
  })

  it('waits for persistence before reading the summary and never falls back after capture failure', async () => {
    const source = patchT3Changes(readFileSync(new URL('../node_modules/t3/dist/bin.mjs', import.meta.url), 'utf8'))
    const helper = source.slice(source.indexOf('/* cate: agent change ingestion v1 */'))
    const order = []
    const fetch = vi.fn(async (url) => { order.push(url); return { ok: true, json: async () => url.endsWith('/summary') ? [{ path: 'a.ts' }] : [] } })
    const context = { process: { env: { CATE_CHANGES_ENDPOINT: 'http://host', CATE_CHANGES_TOKEN: 'token', CATE_CHANGES_SOURCE: 'source' } }, fetch, AbortSignal, console: { warn: vi.fn() } }
    const result = await runInNewContext(helper + ';cateReportChange({threadId:"chat"});cateChangeSummary("chat","turn")', context)
    expect(order).toEqual(['http://host/t3-changes', 'http://host/t3-changes/summary'])
    expect(result).toEqual([{ path: 'a.ts' }])
    fetch.mockRejectedValue(new Error('offline'))
    expect(await runInNewContext('cateChangeSummary("chat","turn")', context)).toEqual([])
  })
})
