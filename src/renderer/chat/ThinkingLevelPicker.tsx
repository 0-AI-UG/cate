import { useRef } from 'react'
import type { CodingThinkingLevel } from '../../shared/types'
import { Tooltip } from '../ui/Tooltip'
import { NodePopover, useNodePopover } from '../ui/Popover'

const THINKING_LEVELS: CodingThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const THINKING_BARS: Record<CodingThinkingLevel, number> = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5 }
const TOTAL_BARS = 5

function ThinkingBars({ count, size = 10 }: { count: number; size?: number }) {
  const barWidth = 2
  const gap = 1
  const totalWidth = TOTAL_BARS * barWidth + (TOTAL_BARS - 1) * gap
  return (
    <svg width={totalWidth} height={size} className="shrink-0" aria-hidden="true">
      {Array.from({ length: TOTAL_BARS }, (_, index) => {
        const height = ((index + 1) / TOTAL_BARS) * size
        return (
          <rect
            key={index}
            x={index * (barWidth + gap)}
            y={size - height}
            width={barWidth}
            height={height}
            rx={0.5}
            fill="currentColor"
            opacity={index < count ? 1 : 0.2}
          />
        )
      })}
    </svg>
  )
}

export function ThinkingLevelPicker({
  level,
  onChange,
  disabled,
}: {
  level: CodingThinkingLevel | null
  onChange: (level: CodingThinkingLevel) => void
  disabled?: boolean
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { open, setOpen, popoverRef, pos, portalTarget } = useNodePopover(
    buttonRef,
    (rect) => ({ left: Math.max(4, rect.right - 160), gap: 4 }),
  )
  const current = level ?? 'medium'
  return (
    <>
      <Tooltip label={`Reasoning effort: ${current}`} placement="top">
        <button
          ref={buttonRef}
          type="button"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] text-muted/70 hover:bg-hover hover:text-primary disabled:opacity-50"
          aria-label={`Reasoning effort: ${current}`}
          aria-expanded={open}
        >
          <ThinkingBars count={THINKING_BARS[current]} />
        </button>
      </Tooltip>
      {open && (
        <NodePopover
          popoverRef={popoverRef}
          pos={pos}
          portalTarget={portalTarget}
          width={160}
          bodyClassName="overflow-hidden"
        >
          <div className="border-b border-subtle px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">Thinking level</div>
          {THINKING_LEVELS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === current}
              onClick={() => { setOpen(false); onChange(option) }}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-[12px] capitalize ${
                option === current ? 'bg-hover-strong text-primary' : 'text-primary hover:bg-hover'
              }`}
            >
              <span>{option}</span>
              <ThinkingBars count={THINKING_BARS[option]} />
            </button>
          ))}
        </NodePopover>
      )}
    </>
  )
}
