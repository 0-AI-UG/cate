// =============================================================================
// ChatApprovalCard — inline Allow/Deny card for a pending tool-call approval
// request. Shows the tool name + its stringified args.
// =============================================================================

import { Wrench } from '@phosphor-icons/react'
import { prettyArgs } from './chatShared'

export function ApprovalCard({
  req,
  onDecide,
}: {
  req: { toolCallId: string; toolName: string; args: unknown }
  onDecide: (decision: 'allow' | 'deny') => void
}) {
  return (
    <div className="rounded-lg border border-agent/40 bg-agent/10 px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 text-[12px] text-primary">
        <Wrench size={12} className="text-agent-light" />
        <span>
          Allow <strong className="font-mono">{req.toolName}</strong>?
        </span>
      </div>
      <pre className="text-[11px] text-primary/80 whitespace-pre-wrap break-words font-mono max-h-[160px] overflow-auto bg-surface-0 rounded p-2 select-text cursor-text">
        {prettyArgs(req.args)}
      </pre>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onDecide('allow')}
          className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium"
        >
          Allow
        </button>
        <button
          onClick={() => onDecide('deny')}
          className="px-2.5 py-1 rounded-md bg-hover hover:bg-hover-strong text-primary text-[11px] font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  )
}
