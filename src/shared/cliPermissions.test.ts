import { describe, expect, it } from 'vitest'
import { cliPermissionForRequest } from './cliPermissions'

describe('browser code permissions', () => {
  it('classifies observations independently of actions invoked by a cell', () => {
    for (const method of ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'listTabs', 'waitFor', 'downloads']) {
      expect(cliPermissionForRequest(`cate.browser.${method}`, {})?.key).toBe('cliBrowserReadEnabled')
    }
    for (const method of ['getTab', 'run', 'reset', 'click', 'typeText', 'setValue', 'goto', 'createTab', 'close', 'unknown']) {
      expect(cliPermissionForRequest(`cate.browser.${method}`, {})?.key).toBe('cliBrowserControlEnabled')
    }
  })
})
