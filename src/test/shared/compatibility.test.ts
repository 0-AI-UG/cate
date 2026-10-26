// Which clients a runtime serves: only those of its own version (7.10).

import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_VERSION } from '@runtime/daemon/contract'
import { startSharedWorkspace, until, type SharedWorkspace } from '../sharedWorkspace'

let ws: SharedWorkspace | undefined
afterEach(async () => { await ws?.stop(); ws = undefined })

describe.skipIf(process.platform === 'win32')('shared workspace: compatibility', () => {
  it('a client of another version is incompatible; the runtime answers it only for its version and update', async () => {
    ws = await startSharedWorkspace()
    for (const version of [`${RUNTIME_VERSION}.1`, '0.0.1']) {
      const other = ws.connect(`Cate ${version}`, { version })
      await until(() => (other.connection.state.kind === 'incompatible' ? true : undefined), 5_000, 'incompatible')
      expect(other.connection.state).toEqual({ kind: 'incompatible', runtimeVersion: RUNTIME_VERSION })
      await expect(other.connection.runtime.workspace.info()).rejects.toThrow(RUNTIME_VERSION)
      await expect(other.connection.runtime.runtime.info()).resolves.toMatchObject({ version: RUNTIME_VERSION })
    }
  })
})
