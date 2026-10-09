// The kernel's own `cate` methods: the API version and notifications.

import { defineCateApi } from './define'
import { defineCliArea } from './permissions'
import { oneOf, opt, str } from './schema'

/** Bumped when a method is removed or changes incompatibly. */
export const CATE_API_VERSION = 10

/** The CLI permission area of these methods. */
export const notifyCliArea = defineCliArea({
  label: 'Notifications',
  control: {
    key: 'cliNotifyEnabled',
    code: 'notify-disabled',
    detail: '`cate notify <message>`: post a notification from a terminal.',
  },
})

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
  { area: notifyCliArea },
)
