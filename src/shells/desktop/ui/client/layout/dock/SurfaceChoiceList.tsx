// The list of panel types an empty window or a surface placeholder offers:
// compact rows, each with a single-letter key (the first letter of its label
// not already taken by an earlier row). The key works while the list has focus.

import React, { useEffect, useRef } from 'react'
import { Icon } from '../../../kernel/interaction'
import { isIconName, type IconName } from '@kernel/interaction/contract'

export interface SurfaceChoice { type: string; label: string; icon: string }

/** One letter per label: the first of its letters no earlier row has taken. */
export function choiceKeys(labels: readonly string[]): (string | undefined)[] {
  const taken = new Set<string>()
  return labels.map((label) => {
    const letter = [...label.toLowerCase()].find((c) => /[a-z0-9]/.test(c) && !taken.has(c))
    if (letter) taken.add(letter)
    return letter
  })
}

export function SurfaceChoiceList({ choices, onPick }: { choices: readonly SurfaceChoice[]; onPick: (type: string) => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const keys = choiceKeys(choices.map((c) => c.label))
  const handler = useRef<(event: KeyboardEvent) => void>(() => {})
  handler.current = (event) => {
    const el = ref.current
    if (!el || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || el.getClientRects().length === 0) return
    // Only while focus is nowhere in particular or inside this chooser's own pane.
    const active = document.activeElement
    if (active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return
    const scope = el.closest('[data-dock-stack-id]') ?? el.parentElement
    if (active && active !== document.body && !scope?.contains(active)) return
    const index = keys.indexOf(event.key.toLowerCase())
    if (index < 0) return
    event.preventDefault()
    event.stopPropagation()
    onPick(choices[index].type)
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handler.current(event)
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [])
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Open a surface"
      className="flex w-full flex-col gap-0.5"
    >
      {choices.map((choice, index) => (
        <button
          type="button"
          key={choice.type}
          onClick={() => onPick(choice.type)}
          className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-[12px] text-primary hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
        >
          {isIconName(choice.icon) && <Icon name={choice.icon as IconName} size={14} className="shrink-0 text-muted" />}
          <span className="flex-1 truncate">{choice.label}</span>
          {keys[index] && (
            <kbd className="min-w-[18px] rounded bg-surface-2 px-1 text-center font-sans text-[10px] uppercase leading-[18px] text-muted">{keys[index]}</kbd>
          )}
        </button>
      ))}
    </div>
  )
}
