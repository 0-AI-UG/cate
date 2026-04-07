import React from 'react'
import { Sidebar, SidebarSimple } from '@phosphor-icons/react'

interface Props {
  size?: number
  direction: 'open' | 'close'
}

export const SidebarToggleIcon: React.FC<Props> = ({ size = 16, direction }) => {
  const Icon = direction === 'open' ? Sidebar : SidebarSimple
  return <Icon size={size} />
}
