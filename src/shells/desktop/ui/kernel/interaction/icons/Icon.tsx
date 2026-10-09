import type { ComponentType, CSSProperties } from 'react'
import { Folders, GitCompareArrows, Globe, Grid2X2, Plus, Terminal } from 'lucide-react'
import type { IconName } from '@kernel/interaction/contract'
import { T3Logo } from './T3Logo'

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
  t3: T3Logo,
}

export function Icon({ name, ...props }: IconProps & { name: IconName }) {
  const Component = ICONS[name]
  return <Component {...props} />
}
