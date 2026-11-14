import type { RuntimeProxy } from '@kernel/rpc/contract'
import { createRepositoryReadCache, type RepositoryReadCache } from '@workspace/repository/client'

const caches = new WeakMap<RuntimeProxy, RepositoryReadCache>()

export function repositoryReadCacheFor(runtime: RuntimeProxy): RepositoryReadCache {
  let cache = caches.get(runtime)
  if (!cache) { cache = createRepositoryReadCache(runtime.vcs); caches.set(runtime, cache) }
  return cache
}
