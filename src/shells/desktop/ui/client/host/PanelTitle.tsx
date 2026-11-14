import { useEffect, useMemo, useState, type MouseEventHandler, type ReactNode } from 'react'
import type { PanelRecord } from '@workspace/document/contract'
import { panelDefinition, panelRowLabel } from '@client/host'
import { isIconName } from '@kernel/interaction/contract'
import { Icon, ShimmerText } from '../../kernel/interaction'
import { useWorktreeColor } from '../../workspace/repository'
import { useDocument } from '../document'
import { usePanelDecorations, type PanelDecoration } from './panelDecorations'

type TitleRecord = { type: string; title: string }

export function panelTitleLabel(record: TitleRecord, decoration?: PanelDecoration): string {
  const title = panelRowLabel(record)
  return decoration?.retitle?.(title) ?? title
}

export interface PanelTitleProps {
  record: TitleRecord
  decoration?: PanelDecoration
  worktreeKey?: string
  iconSize?: number
  className?: string
  textClassName?: string
  iconClassName?: string
  onDoubleClick?: MouseEventHandler<HTMLSpanElement>
  /** An inline rename field replaces the text while keeping its icon/status. */
  children?: ReactNode
}

/** One rendering for panel labels: logo/type icon, title, activity and status. */
export function PanelTitle({ record, decoration, worktreeKey, iconSize = 12, className = '', textClassName = '', iconClassName = '', onDoubleClick, children }: PanelTitleProps) {
  const color = useWorktreeColor(worktreeKey)
  const title = panelTitleLabel(record, decoration)
  return <span className={`flex min-w-0 flex-1 items-center gap-1.5 ${className}`}>
    <span className={`shrink-0 ${iconClassName}`}><PanelIcon type={record.type} size={iconSize} logo={decoration?.logo} logoAlt={decoration?.logoAlt} /></span>
    {children ?? <ShimmerText className={`min-w-0 flex-1 truncate ${textClassName}`} active={!!decoration?.busy} color={color} onDoubleClick={onDoubleClick}>{title}{decoration?.dirty ? ' •' : ''}</ShimmerText>}
    {decoration?.status}
  </span>
}

function PanelIcon({ type, size, logo, logoAlt }: { type: string; size: number; logo?: string | null; logoAlt?: string | null }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [logo])
  if (logo && !failed) return <img src={logo} alt="" title={logoAlt ?? undefined} width={size} height={size} className="block object-contain" style={{ width: size, height: size }} draggable={false} onError={() => setFailed(true)} />
  const icon = panelDefinition(type)?.icon
  return <Icon name={isIconName(icon) ? icon : 'plus'} size={size} />
}

/** Read live decorations once per list, not once per title or recorded edit. */
export function usePanelTitles(workspaceId: string | null | undefined) {
  const decorations = usePanelDecorations(workspaceId ?? '')
  const worktrees = useDocument(workspaceId, (document) => document.worktrees)
  const tint = Object.keys(worktrees).length >= 2
  return useMemo(() => ({
    decorations,
    label: (record: PanelRecord) => panelTitleLabel(record, decorations[record.id]),
    props: (record: PanelRecord): PanelTitleProps => ({
      record,
      decoration: decorations[record.id],
      worktreeKey: tint && record.worktreeId ? worktrees[record.worktreeId]?.color : undefined,
    }),
  }), [decorations, worktrees, tint])
}
