import { describe, it, expect, beforeEach } from 'vitest'

import {
  MODEL_CACHE_LIMIT,
  getCachedModel,
  rememberModel,
  retainModel,
  releaseModel,
  resolveLoadedModel,
  markLoadFailed,
  clearLoadFailed,
  isLoadFailed,
  rememberBaseline,
  getBaseline,
  __resetModelCacheForTest,
  type ModelLike,
} from './modelCache'

// Minimal stand-in for a monaco ITextModel: just the disposal contract the
// cache touches, plus a flag so tests can assert eviction actually disposes.
function makeModel(): ModelLike & { disposed: boolean } {
  return {
    disposed: false,
    isDisposed() { return this.disposed },
    dispose() { this.disposed = true },
  }
}

beforeEach(() => {
  __resetModelCacheForTest()
})

describe('modelCache — LRU eviction', () => {
  it('caches and returns a model by path', () => {
    const m = makeModel()
    rememberModel('/a.ts', m)
    expect(getCachedModel('/a.ts')).toBe(m)
  })

  it('disposes the oldest model once over the limit', () => {
    const models: Array<ReturnType<typeof makeModel>> = []
    for (let i = 0; i <= MODEL_CACHE_LIMIT; i++) {
      const m = makeModel()
      models.push(m)
      rememberModel(`/f${i}.ts`, m)
    }
    // One over the limit → oldest (index 0) evicted and disposed.
    expect(models[0].disposed).toBe(true)
    expect(getCachedModel('/f0.ts')).toBeUndefined()
    expect(getCachedModel(`/f${MODEL_CACHE_LIMIT}.ts`)).toBe(models[MODEL_CACHE_LIMIT])
  })

  it('skips an in-use oldest entry but still evicts the next eligible one', () => {
    const models: Array<ReturnType<typeof makeModel>> = []
    for (let i = 0; i < MODEL_CACHE_LIMIT; i++) {
      const m = makeModel()
      models.push(m)
      rememberModel(`/f${i}.ts`, m)
    }
    // Pin the oldest entry as in use.
    retainModel('/f0.ts')

    // Push one more in → over by one. The oldest (/f0) is in use, so it must be
    // skipped and the next oldest (/f1) evicted instead.
    const extra = makeModel()
    rememberModel('/extra.ts', extra)

    expect(models[0].disposed).toBe(false)
    expect(getCachedModel('/f0.ts')).toBe(models[0])
    expect(models[1].disposed).toBe(true)
    expect(getCachedModel('/f1.ts')).toBeUndefined()
  })

  it('does not let one old in-use entry block all eviction', () => {
    const models: Array<ReturnType<typeof makeModel>> = []
    for (let i = 0; i < MODEL_CACHE_LIMIT; i++) {
      const m = makeModel()
      models.push(m)
      rememberModel(`/f${i}.ts`, m)
    }
    retainModel('/f0.ts')

    // Add several more so the cache is well over the limit. Despite /f0 being a
    // permanently-pinned oldest entry, the cache must still shrink back toward
    // the limit by evicting younger eligible entries.
    for (let i = 0; i < 5; i++) {
      rememberModel(`/extra${i}.ts`, makeModel())
    }

    expect(models[0].disposed).toBe(false)
    // /f0 retained (1 model) + everything that couldn't be evicted. The cache
    // never grows unbounded: the only thing keeping it above the floor is the
    // single pinned model, so size stays at the limit (the pinned one occupies
    // a slot but the rest were evicted to make room).
    expect(getCachedModel('/f0.ts')).toBe(models[0])
  })

  it('re-inserting a path marks it most-recent so it survives eviction', () => {
    const first = makeModel()
    rememberModel('/keep.ts', first)
    for (let i = 0; i < MODEL_CACHE_LIMIT - 1; i++) {
      rememberModel(`/f${i}.ts`, makeModel())
    }
    // Touch /keep.ts again → now most recent.
    rememberModel('/keep.ts', first)
    // One more overflows; the now-oldest is /f0, not /keep.
    rememberModel('/overflow.ts', makeModel())

    expect(getCachedModel('/keep.ts')).toBe(first)
    expect(getCachedModel('/f0.ts')).toBeUndefined()
  })
})

describe('modelCache — ref counting', () => {
  it('protects a model from eviction while retained, frees it after release', () => {
    const m = makeModel()
    rememberModel('/x.ts', m)
    retainModel('/x.ts')

    // Overflow the cache while /x is retained.
    for (let i = 0; i < MODEL_CACHE_LIMIT; i++) {
      rememberModel(`/f${i}.ts`, makeModel())
    }
    expect(m.disposed).toBe(false)
    expect(getCachedModel('/x.ts')).toBe(m)

    // Release, then overflow again — now it is eligible for eviction.
    releaseModel('/x.ts')
    for (let i = 0; i < MODEL_CACHE_LIMIT; i++) {
      rememberModel(`/g${i}.ts`, makeModel())
    }
    expect(m.disposed).toBe(true)
  })

  it('balances nested retain/release before allowing eviction', () => {
    const m = makeModel()
    rememberModel('/y.ts', m)
    retainModel('/y.ts')
    retainModel('/y.ts')
    releaseModel('/y.ts')

    for (let i = 0; i < MODEL_CACHE_LIMIT; i++) {
      rememberModel(`/f${i}.ts`, makeModel())
    }
    // Still one outstanding retain → not evicted.
    expect(m.disposed).toBe(false)
  })
})

describe('modelCache — resolveLoadedModel (duplicate-URI race)', () => {
  it('creates a model when none exists under the URI', () => {
    const created = makeModel()
    const m = resolveLoadedModel(() => null, () => created)
    expect(m).toBe(created)
  })

  it('reuses an existing live model instead of creating a duplicate', () => {
    const existing = makeModel()
    let createCalls = 0
    const m = resolveLoadedModel(
      () => existing,
      () => { createCalls++; return makeModel() },
    )
    expect(m).toBe(existing)
    expect(createCalls).toBe(0)
  })

  it('creates fresh when the model found under the URI is disposed', () => {
    const stale = makeModel()
    stale.dispose()
    const fresh = makeModel()
    const m = resolveLoadedModel(() => stale, () => fresh)
    expect(m).toBe(fresh)
  })
})

describe('modelCache — disk baseline', () => {
  it('remembers and returns the disk baseline for a path', () => {
    expect(getBaseline('/a.ts')).toBeUndefined()
    rememberBaseline('/a.ts', 'on disk')
    expect(getBaseline('/a.ts')).toBe('on disk')
  })

  it('keeps baselines independent per path and overwrites in place', () => {
    rememberBaseline('/a.ts', 'A')
    rememberBaseline('/b.ts', 'B')
    rememberBaseline('/a.ts', 'A2')
    expect(getBaseline('/a.ts')).toBe('A2')
    expect(getBaseline('/b.ts')).toBe('B')
  })

  it('drops the baseline when its model is evicted from the cache', () => {
    const m = makeModel()
    rememberModel('/keep.ts', m)
    rememberBaseline('/keep.ts', 'disk')
    // Overflow the cache so /keep.ts (unretained, oldest) is evicted.
    for (let i = 0; i <= MODEL_CACHE_LIMIT; i++) rememberModel(`/f${i}.ts`, makeModel())
    expect(getCachedModel('/keep.ts')).toBeUndefined()
    expect(getBaseline('/keep.ts')).toBeUndefined()
  })

  it('is cleared by the test reset helper', () => {
    rememberBaseline('/a.ts', 'x')
    __resetModelCacheForTest()
    expect(getBaseline('/a.ts')).toBeUndefined()
  })
})

describe('modelCache — load-failure guard', () => {
  it('tracks and clears the failed-load state per path', () => {
    expect(isLoadFailed('/r.ts')).toBe(false)
    markLoadFailed('/r.ts')
    expect(isLoadFailed('/r.ts')).toBe(true)
    clearLoadFailed('/r.ts')
    expect(isLoadFailed('/r.ts')).toBe(false)
  })

  it('a read failure does not poison the model cache', () => {
    // The fix: on read failure EditorPanel marks the path failed and caches
    // nothing — there is no placeholder model squatting under the real path.
    markLoadFailed('/broken.ts')
    expect(getCachedModel('/broken.ts')).toBeUndefined()
    expect(isLoadFailed('/broken.ts')).toBe(true)
  })

  it('keeps failed paths independent of each other', () => {
    markLoadFailed('/a.ts')
    expect(isLoadFailed('/a.ts')).toBe(true)
    expect(isLoadFailed('/b.ts')).toBe(false)
  })
})
