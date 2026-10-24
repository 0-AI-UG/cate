// The kernel's own `cate` method: the API version.

import { defineCateApi } from './define'

/** Bumped when a method is removed or changes incompatibly. */
export const CATE_API_VERSION = 11

export const versionApi = defineCateApi('', {
  version: {
    access: 'read',
    handler: 'service',
    summary: 'Print the cate API version',
  },
})
