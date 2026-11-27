import type { ComponentType, CSSProperties } from 'react'
import { Folders, GitCompareArrows, Globe, Grid2X2, Pencil, Plus, StickyNote, Terminal, Type } from 'lucide-react'
import type { IconName } from '@kernel/interaction/contract'

export interface IconProps {
  size?: number | string
  className?: string
  style?: CSSProperties
}

const ICONS: Record<IconName, ComponentType<IconProps>> = {
  terminal: Terminal,
  globe: Globe,
  folders: Folders,
  grid: Grid2X2,
  'git-compare': GitCompareArrows,
  plus: Plus,
  'sticky-note': StickyNote,
  type: Type,
  pencil: Pencil,
}

export function Icon({ name, ...props }: IconProps & { name: IconName }) {
  const Component = ICONS[name]
  return <Component {...props} />
}
