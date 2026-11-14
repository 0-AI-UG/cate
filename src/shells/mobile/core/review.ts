// Review views in the app (`review.*`): what a review panel's view needs
// beyond its session's ops, each computed as every client's review does:
// the agents it can hand the review to, by name; a
// changed file opened in an editor.

import { createPanel } from '@client/host'
import { agentDisplayName } from '@services/agents/contract'
import {
  reviewFilePath,
  type ReviewAgentChoice,
  type ReviewSnapshot,
} from '@panels/review/contract'
import type { MobileCoreMethods } from '../contract'
import type { MobileViews } from './views'

type Handlers<M extends keyof MobileCoreMethods> = {
  [K in M]: (params: MobileCoreMethods[K]['params']) => Promise<MobileCoreMethods[K]['result']>
}

export type ReviewMethod = 'review.agents' | 'review.openFile'

export function createReviewHandlers(views: MobileViews): Handlers<ReviewMethod> {
  const view = (viewId: string) => views.get<ReviewSnapshot>(viewId)
  return {
    async 'review.agents'({ viewId }) {
      const choices = (await view(viewId)?.send({ kind: 'reviewAgents' }).catch(() => null) ?? []) as ReviewAgentChoice[]
      return choices.map((choice) => ({ ...choice, name: agentDisplayName(choice.agentId) }))
    },
    async 'review.openFile'({ viewId, path }) {
      const found = view(viewId)
      const repoPath = found?.snapshot()?.review.repoPath
      if (!found || repoPath === undefined) return null
      return createPanel(found.workspaceId, 'editor', {
        filePath: reviewFilePath(repoPath, path),
        title: path.split('/').pop(),
        near: found.panelId,
      })
    },
  }
}
