// Every `cate` API namespace: the daemon's router serves this list and the
// CLI knows the same one. Pure; it sits at the panels level because it names
// specs from every layer.

import { versionApi, type CateApiNamespace } from '@kernel/api/contract'
import { canvasApi, panelApi } from '@workspace/document/contract/api'
import { agentApi } from '@services/agents/contract/api'
import { terminalApi } from './terminal/contract/api'
import { browserApi } from '@services/browser/contract/api'
import { editorApi } from './editor/contract/api'
import { reviewApi } from './review/contract/api'

export const CATE_API: readonly CateApiNamespace<any>[] = [
  versionApi,
  panelApi,
  canvasApi,
  terminalApi,
  browserApi,
  editorApi,
  reviewApi,
  agentApi,
]
