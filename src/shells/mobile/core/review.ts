// Review views in the app (`review.*`): what a review panel's view needs
// beyond its session's ops, each computed as every client's review does:
// the agents it can hand the review to, by name; its notes as Markdown; a
// changed file opened in an editor; a changed image's two versions.

import { createPanel } from '@client/host'
import { agentDisplayName } from '@services/agents/contract'
import {
  notesMarkdown,
  reviewFilePath,
  reviewImageMime,
  type ReviewAgentChoice,
  type ReviewSnapshot,
} from '@panels/review/contract'
import type { MobileCoreMethods } from '../contract'
import type { MobileViews } from './views'

type Handlers<M extends keyof MobileCoreMethods> = {
  [K in M]: (params: MobileCoreMethods[K]['params']) => Promise<MobileCoreMethods[K]['result']>
}

export type ReviewMethod = 'review.agents' | 'review.notes' | 'review.openFile' | 'review.images'

export function createReviewHandlers(views: MobileViews): Handlers<ReviewMethod> {
  const view = (viewId: string) => views.get<ReviewSnapshot>(viewId)
  return {
    async 'review.agents'({ viewId }) {
      const choices = (await view(viewId)?.send({ kind: 'reviewAgents' }).catch(() => null) ?? []) as ReviewAgentChoice[]
      return choices.map((choice) => ({ ...choice, name: agentDisplayName(choice.agentId) }))
    },
    async 'review.notes'({ viewId }) {
      return notesMarkdown(view(viewId)?.snapshot()?.review.notes ?? [])
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
    async 'review.images'({ viewId, path, oldPath }) {
      const mime = reviewImageMime(path)
      const found = view(viewId)
      if (!mime || !found) return null
      const images = await found.send({ kind: 'images', path, ...(oldPath ? { oldPath } : {}) }) as { old: string | null; new: string | null }
      return { mime, old: images.old, new: images.new }
    },
  }
}
