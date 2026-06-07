import { describe, expect, test } from 'vitest'
import { hydrateSessionTrust } from './sessionTrust'
import type { MultiWorkspaceSession } from '../shared/types'

describe('hydrateSessionTrust', () => {
  test('sanitizes invalid workspace roots and returns accepted roots', async () => {
    const session: MultiWorkspaceSession = {
      version: 2,
      selectedWorkspaceIndex: 0,
      workspaces: [
        {
          workspaceName: 'Good',
          rootPath: '/good',
        },
        {
          workspaceName: 'Bad',
          rootPath: '/bad',
        },
      ],
    }

    const hydrated = await hydrateSessionTrust(session, async (rootPath) => (
      rootPath === '/good' ? '/private/good' : null
    ))

    expect(hydrated.acceptedRoots).toEqual(['/private/good'])
    expect(hydrated.sanitizedSession.workspaces[0].rootPath).toBe('/private/good')
    expect(hydrated.sanitizedSession.workspaces[1].rootPath).toBeNull()
  })
})
