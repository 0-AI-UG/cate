import { SourceControlView } from '../sidebar/SourceControlView'
import { useAppStore } from '../stores/appStore'
import type { PanelProps } from './types'

export default function SourceControlPanel({ workspaceId }: PanelProps) {
  const rootPath = useAppStore((s) => s.getWorkspace(workspaceId)?.rootPath ?? '')
  return <SourceControlView rootPath={rootPath} />
}
