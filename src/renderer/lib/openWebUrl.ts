import { isWebUrl } from '../../shared/webUrl'
import { useAppStore } from '../stores/appStore'
import { createInteractivePanel } from './panels/createInteractivePanel'

/** External links get a visible dock tab, including on a fresh installation
 * with no project folder. Browsing does not require granting filesystem access. */
export function openWebUrl(url: string): string | null {
  if (!isWebUrl(url)) return null
  const app = useAppStore.getState()
  const workspaceId = app.selectedWorkspaceId || app.addWorkspace()
  return createInteractivePanel('browser', {
    workspaceId,
    url,
    placement: { target: 'dock', zone: 'center' },
  })
}
