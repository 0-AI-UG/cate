// How browser observations and failures read to an agent: the text a code
// cell or the CLI prints, diffs between accessibility trees, and what to do
// after each page-driver error. Hints name both surfaces: the CLI command
// and the code-cell call.
import type { BrowserObservation } from './automation'

const depthOf = (line: string): number => (line.length - line.trimStart().length) / 2

/** The lines of `tree` that changed, each under the ancestor lines that
 *  locate it (unmarked), removals first. */
function marked(tree: string[], changed: Set<string>, mark: string): string[] {
  const out: string[] = []
  const ancestors: Array<{ line: string; printed: boolean }> = []
  for (const line of tree) {
    const depth = depthOf(line)
    ancestors.length = Math.min(ancestors.length, depth)
    if (changed.has(line)) {
      for (const ancestor of ancestors) {
        if (!ancestor.printed) out.push(`  ${ancestor.line}`)
        ancestor.printed = true
      }
      out.push(`${mark} ${line}`)
    }
    ancestors[depth] = { line, printed: changed.has(line) }
  }
  return out
}

/** A line diff of two accessibility trees with ancestor context. */
export function diffBrowserState(before: string, after: string): string {
  const old = before ? before.split('\n') : []
  const current = after ? after.split('\n') : []
  const oldSet = new Set(old)
  const currentSet = new Set(current)
  const removed = new Set(old.filter(line => !currentSet.has(line)))
  const added = new Set(current.filter(line => !oldSet.has(line)))
  const lines = [...marked(old, removed, '-'), ...marked(current, added, '+')]
  return lines.length ? lines.join('\n') : 'No changes.'
}

const RECOVERY: Record<string, string> = {
  'element-obscured': 'Another element covers the target. Close or dismiss it (a dialog, banner or menu), then retry.',
  'element-not-visible': 'The element stayed hidden. Open the menu, tab or section that shows it, observe, then retry.',
  'element-disabled': 'The element stayed disabled. Fill in what it depends on, or wait for it (cate browser wait --element <id> --state enabled, or waitFor({element:id, state:"enabled"}) in code).',
  'element-not-stable': 'The element kept moving. Wait for the animation to finish, then retry.',
  'element-has-no-actionable-box': 'The element has no size on screen. Pick a visible element from a fresh observation.',
  'element-not-editable': 'The target is not a text field. Use the id of a textbox, searchbox or editable region.',
  'element-readonly': 'The field is read-only.',
  'element-not-found': 'The element is gone. Observe again and use a current id.',
  'stale-browser-element': 'The element is gone or the page changed. Observe again and use a current id.',
  'browser-element-not-in-observation': 'Use an id from the latest observation; observe again if the page changed.',
  'stale-browser-observation': 'The page navigated since that observation. Observe again and use the new ids.',
  'stale-browser-coordinates': 'The page scrolled or resized since those coordinates. Take a new screenshot first.',
  'browser-observation-required': 'Observe the tab first.',
  'browser-ax-observation-required': 'Element ids need an accessibility snapshot: run cate browser snapshot (getAXState() in code) first.',
  'browser-action-preempted-by-user': 'The user used the page. Observe again and check what they changed before continuing.',
  'browser-page-hidden': 'The browser panel is not on screen (scrolled off the canvas, or behind another tab or window), so it paints nothing to capture. Bring it into view, or take an accessibility snapshot (cate browser snapshot, or getAXState() in code), which works while hidden.',
  'browser-render-frame-timeout': 'The page painted no frame. Bring the browser panel into view, or take an accessibility snapshot (cate browser snapshot, or getAXState() in code), which works while hidden.',
  'browser-screenshot-timeout': 'The screenshot did not finish. Bring the browser panel into view, or take an accessibility snapshot (cate browser snapshot, or getAXState() in code), which works while hidden.',
  'browser-wait-timeout': 'The condition did not hold in time. Observe to see the current state.',
  'browser-option-not-found': 'No enabled option has that value. Option values can differ from their labels: read them from the observation.',
  'browser-type-target-not-focused': 'Focus a text field first: click it, or fill it (cate browser fill <id> <text>, or setValue(id, text) in code).',
  'browser-type-failed': 'The text did not change the field. Click the field first, or fill it (cate browser fill <id> <text>, or setValue(id, text) in code).',
  'browser-fill-postcondition-failed': 'The page rewrote the value. Observe to see what it holds now.',
  'browser-checkbox-required': 'The target is not a checkbox or radio. Click custom toggles instead (cate browser click <id>, or click(id) in code).',
  'browser-select-required': 'The target is not a <select>. Click a custom dropdown open, then click its option.',
}

/** What to do after a page-driver error. `inputSent`: the call had already
 *  sent input or changed the page before it failed. */
export function browserRecovery(error: string, inputSent: boolean): string | undefined {
  const code = error.split(':')[0]
  const hint = RECOVERY[code]
  if (hint) return inputSent ? `${hint} Input was already sent, so check the page before repeating it.` : hint
  // An argument the call got wrong says what to fix itself.
  if (code.startsWith('invalid-') || code.endsWith('-required') || code.startsWith('unsupported-')) return undefined
  return inputSent
    ? 'Observe the tab again before retrying; input was already sent.'
    : 'Observe the tab again before retrying.'
}

/** The text of an observation for an agent: the action's outcome, the page,
 *  and the accessibility tree or its changes. */
export function describeBrowserObservation(observation: BrowserObservation, action?: { method: string; status: string }): string {
  const lines: string[] = []
  if (action) lines.push(`${action.method}: ${action.status}`)
  lines.push(`Page: ${observation.title ? `${observation.title} (${observation.url})` : observation.url}`)
  const { viewport } = observation
  if (viewport && (viewport.scrollX || viewport.scrollY)) lines.push(`Scrolled to ${Math.round(viewport.scrollX)},${Math.round(viewport.scrollY)} in a ${viewport.width}x${viewport.height} viewport`)
  if (observation.screenshotError) lines.push(`No screenshot (${observation.screenshotError}): ${browserRecovery(observation.screenshotError, false)}`)
  if (observation.kind === 'image') lines.push('Screenshot only: element ids are unchanged.')
  else if (observation.diff) lines.push('Changes since the last observation:', observation.state)
  else lines.push(observation.state || '(no accessible elements)')
  return lines.join('\n')
}
