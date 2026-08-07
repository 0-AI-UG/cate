import { ChatCircle } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

export function CateAgentEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 py-8 min-h-0">
      <div className="w-full max-w-[520px] flex flex-col items-center">
        <div className="w-12 h-12 rounded-2xl bg-agent/15 flex items-center justify-center mb-4">
          <ChatCircle size={22} className="text-agent-light" />
        </div>
        <div className="text-[16px] font-medium text-primary mb-3 text-center">
          What should we work on?
        </div>
        <div className="w-full">{children}</div>
      </div>
    </div>
  )
}
