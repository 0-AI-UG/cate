import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// installCateControl (and agentDir, which it imports) pull in electron + the
// main logger, neither of which load under the node test env. Stub them so the
// module graph evaluates.
vi.mock('electron', () => ({ app: { getAppPath: () => '/nonexistent', getPath: () => os.tmpdir() } }))
vi.mock('../../main/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { copyIfChanged } from './installCateControl'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-install-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('copyIfChanged', () => {
  it('writes the file (and parent dirs) when the destination is missing', async () => {
    const src = path.join(dir, 'src.ts')
    const dest = path.join(dir, 'nested', 'dest.ts')
    await fs.writeFile(src, 'NEW')
    await copyIfChanged(src, dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('NEW')
  })

  it('overwrites a stale destination whose bytes differ (the protocol-desync bug)', async () => {
    // Regression: skip-if-exists left an old extension installed, so the agent
    // emitted action names (cate_open_panel) the renderer no longer handled.
    const src = path.join(dir, 'src.ts')
    const dest = path.join(dir, 'dest.ts')
    await fs.writeFile(src, 'tool("cate_panel")')
    await fs.writeFile(dest, 'tool("cate_open_panel")')
    await copyIfChanged(src, dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('tool("cate_panel")')
  })

  it('does not rewrite when the destination already matches', async () => {
    const src = path.join(dir, 'src.ts')
    const dest = path.join(dir, 'dest.ts')
    await fs.writeFile(src, 'SAME')
    await fs.writeFile(dest, 'SAME')
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(dest, past, past)
    const before = (await fs.stat(dest)).mtimeMs
    await copyIfChanged(src, dest)
    expect((await fs.stat(dest)).mtimeMs).toBe(before) // skipped — not rewritten
  })
})
