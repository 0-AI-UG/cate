// Release versions do not decide runtime compatibility (7.10).

import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_VERSION } from '@runtime/daemon/contract'
import { startSharedWorkspace, until, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace | undefined
afterEach(async () => { await ws?.stop(); ws = undefined })

describe.skipIf(process.platform === 'win32')('shared workspace: compatibility', () => {
  it('serves clients of different releases using the same compatibility version', async () => {
    ws = await startSharedWorkspace()
    for (const version of [`${RUNTIME_VERSION}.1`, '0.0.1']) {
      const other = ws.connect(`Cate ${version}`, { version })
      await until(() => (other.connection.state.kind === 'connected' ? true : undefined), 5_000, 'connected')
      await expect(other.connection.runtime.workspace.info()).resolves.toMatchObject({ root: ws.root })
      await expect(other.connection.runtime.runtime.info()).resolves.toMatchObject({ version: RUNTIME_VERSION })
    }
  })
})
