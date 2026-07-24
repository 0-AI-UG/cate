// =============================================================================
// The trust gate itself (GHSA-8769-jp52-985f).
//
// The whole model is one question with two answers, so what these pin is small:
// a trusted project never asks, an untrusted one always asks, and the answer is
// what the caller gets back. The callers then either open the project or don't.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import { useWorkspaceTrustStore, ensureProjectTrusted, isProjectTrusted } from './workspaceTrustStore'

const projectTrustGet = vi.fn()
const projectTrustSet = vi.fn()

beforeEach(() => {
  projectTrustGet.mockReset().mockResolvedValue([])
  projectTrustSet.mockReset().mockImplementation(async (locator: string) => [locator])
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = { projectTrustGet, projectTrustSet }
  useWorkspaceTrustStore.setState({ trusted: [], hydrated: false, queue: [] })
})

/** Answer the dialog's question, after letting the request enqueue. */
async function answer(trusted: boolean): Promise<void> {
  await Promise.resolve()
  await useWorkspaceTrustStore.getState().answerTrustPrompt(trusted)
}

describe('hydrate', () => {
  it('mirrors the list main holds', async () => {
    projectTrustGet.mockResolvedValue(['/trusted'])
    await useWorkspaceTrustStore.getState().hydrate()
    expect(isProjectTrusted('/trusted')).toBe(true)
    expect(isProjectTrusted('/other')).toBe(false)
  })

  it('fails closed when the list cannot be read', async () => {
    projectTrustGet.mockRejectedValue(new Error('nope'))
    await useWorkspaceTrustStore.getState().hydrate()
    // Every project is re-asked rather than silently opened.
    expect(useWorkspaceTrustStore.getState().trusted).toEqual([])
    expect(useWorkspaceTrustStore.getState().hydrated).toBe(true)
  })
})

describe('ensureProjectTrusted', () => {
  it('passes an already-trusted project through without asking', async () => {
    useWorkspaceTrustStore.setState({ trusted: ['/trusted'], hydrated: true, queue: [] })
    await expect(ensureProjectTrusted('/trusted')).resolves.toBe(true)
    expect(useWorkspaceTrustStore.getState().queue).toHaveLength(0)
  })

  it('asks about an unknown project and opens it when the user trusts it', async () => {
    const gate = ensureProjectTrusted('/repo')
    await Promise.resolve()
    expect(useWorkspaceTrustStore.getState().queue[0]?.locator).toBe('/repo')

    await answer(true)

    await expect(gate).resolves.toBe(true)
    expect(projectTrustSet).toHaveBeenCalledWith('/repo', true)
    expect(useWorkspaceTrustStore.getState().queue).toHaveLength(0)
  })

  it('refuses the open and grants nothing when the user declines', async () => {
    const gate = ensureProjectTrusted('/repo')
    await answer(false)

    await expect(gate).resolves.toBe(false)
    // Declining is not a decision to remember: nothing is written, and the
    // project is simply not opened.
    expect(projectTrustSet).not.toHaveBeenCalled()
    expect(isProjectTrusted('/repo')).toBe(false)
  })

  it('never opens a project without a locator', async () => {
    await expect(ensureProjectTrusted('')).resolves.toBe(false)
    await expect(ensureProjectTrusted(undefined)).resolves.toBe(false)
  })

  it('asks once when two open paths race on the same folder', async () => {
    const a = ensureProjectTrusted('/repo')
    const b = ensureProjectTrusted('/repo')
    await Promise.resolve()

    await answer(true)

    // One question, both callers get the answer.
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(projectTrustSet).toHaveBeenCalledTimes(1)
  })

  it('asks about several projects one at a time, in order', async () => {
    const first = ensureProjectTrusted('/one')
    const second = ensureProjectTrusted('/two')
    await Promise.resolve()

    // Only the head is on screen.
    expect(useWorkspaceTrustStore.getState().queue.map((p) => p.locator)).toEqual(['/one', '/two'])

    await answer(false)
    await expect(first).resolves.toBe(false)
    expect(useWorkspaceTrustStore.getState().queue[0]?.locator).toBe('/two')

    await answer(true)
    await expect(second).resolves.toBe(true)
  })
})
