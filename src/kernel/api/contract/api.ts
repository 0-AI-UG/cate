// The kernel's own `cate` methods: the API version and notifications.

import { defineCateApi } from './define'
import { oneOf, opt, str } from './schema'

/** Bumped when a method is removed or changes incompatibly. */
export const CATE_API_VERSION = 10

export const versionApi = defineCateApi('', {
  version: {
    access: 'read',
    handler: 'service',
    summary: 'Print the cate API version',
  },
})

export const uiApi = defineCateApi(
  'ui',
  {
    notify: {
      access: 'control',
      handler: 'service',
      summary: 'Post a notification to the workspace',
      args: {
        message: str.nonEmpty().rest('message').help('The notification text'),
        level: opt(oneOf('info', 'warning', 'error'), 'info').help('How the notification is shown'),
      },
      cli: { command: ['notify'] },
    },
  },
  { area: 'notify' },
)
