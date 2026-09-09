import { getWorkspaceInfo } from '../workspaceManager'
import { resolveLocator } from '../runtime/runtimeManager'
import { windowFromEvent } from '../windowRegistry'
import { ipcMain } from 'electron'
import { GITHUB_LOGIN, GITHUB_CONNECTION, GITHUB_PR_CONTEXT, PULL_REQUESTS_LIST } from '../../shared/ipc-channels'
import { githubConnection, pullRequestContext, cancelGithubLogin, githubLoginState, listPullRequests, startGithubLogin } from '../github/pullRequests'

export function registerPullRequestHandlers(): void {
  ipcMain.handle(GITHUB_CONNECTION, () => githubConnection())
  ipcMain.handle(GITHUB_PR_CONTEXT, async (event, workspaceId: string, repository: string, number: number) => {
    const workspace = getWorkspaceInfo(workspaceId)
    if (!workspace?.rootPath || workspace.rootPath.startsWith('cate-runtime://')) return null
    const { runtime, path } = resolveLocator(workspace.rootPath)
    if (!await runtime.vcs.isRepo(path, { ownerWindowId: windowFromEvent(event)?.id, scopeId: workspaceId })) return null
    return pullRequestContext(path, repository, number)
  })
  ipcMain.handle(PULL_REQUESTS_LIST, (_event, refresh: unknown) => listPullRequests(refresh === true))
  ipcMain.handle(GITHUB_LOGIN, (event, operation: unknown) => {
    const owner = event.sender.id
    if (operation === 'start') {
      if (githubLoginState(owner).status !== 'pending') event.sender.once('destroyed', () => cancelGithubLogin(owner))
      return startGithubLogin(owner)
    }
    if (operation === 'cancel') cancelGithubLogin(owner)
    return githubLoginState(owner)
  })
}
