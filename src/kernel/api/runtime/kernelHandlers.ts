// Handler for the kernel's own method: `cate.version`.

import { CATE_API_VERSION, versionApi } from '../contract'
import type { ApiRouter } from './router'

export function registerKernelApi(router: ApiRouter): () => void {
  return router.registerService(versionApi, {
    version: () => CATE_API_VERSION,
  })
}
