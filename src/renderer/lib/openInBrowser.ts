import { useAppStore } from '../stores/appStore'
import { requestPanelTarget } from './panelTargetPicker'
import { handleBrowserMethod } from './browser/browserDriver'
import { normalizeUrl } from '../panels/browserUrl'

/** Ask where to open a local file in a browser panel (new placement or an
 *  existing browser), then load it there as a new tab. */
export async function openFileInBrowser(workspaceId: string, filePath: string, sourcePanelId: string): Promise<void> {
  const url = normalizeUrl(filePath)
  const target = await requestPanelTarget({ workspaceId, panelType: 'browser', availability: 'both', sourcePanelId })
  if (!target) return
  const app = useAppStore.getState()
  if (target.kind === 'new') {
    app.createBrowser(workspaceId, url, undefined, target.placement)
    return
  }
  await handleBrowserMethod(workspaceId, 'cate.browser.createTab', { panelId: target.panelId, url })
}
