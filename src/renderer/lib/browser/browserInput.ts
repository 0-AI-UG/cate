// =============================================================================
// browserInput — synthesising real input for a guest page.
//
// Everything here goes through webContents.sendInputEvent, which produces
// isTrusted events. That is deliberate: synthetic el.click() / dispatchEvent
// input is rejected by a lot of real-world UI (drag handles, rich text editors,
// anything gating on isTrusted), so an agent driving with synthetic events looks
// like it works right up until it silently does nothing on the page that matters.
//
// The cost of real input is that it is INVISIBLE — there is no pointer on
// screen. Every helper here therefore emits an agentCursor event first, so the
// overlay can draw what is about to happen before it happens.
// =============================================================================

import { emitAgentCursor, type AgentCursorEvent } from './agentCursor'
import type { PortalInputModifier, PortalWebview } from '../portalRegistry'

export interface InputTarget {
  webview: PortalWebview
  panelId: string
}

/** Friendly key names → Electron accelerator key codes. Single printable
 *  characters pass through as themselves, so `press a` and `press cmd+k` work
 *  without enumerating the alphabet. */
const NAMED_KEYS: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  insert: 'Insert',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
}

const MODIFIER_ALIASES: Record<string, PortalInputModifier> = {
  shift: 'shift',
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
}

export interface ParsedKey {
  keyCode: string
  modifiers: PortalInputModifier[]
}

/** Parse `cmd+shift+k`, `Enter`, `a`. Returns null for an unknown key name so
 *  the caller reports `unsupported-key` rather than sending nonsense. */
export function parseKeyCombo(raw: string): ParsedKey | null {
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return null
  const keyPart = parts.pop() as string
  const modifiers: PortalInputModifier[] = []
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (!mod) return null
    if (!modifiers.includes(mod)) modifiers.push(mod)
  }
  const named = NAMED_KEYS[keyPart.toLowerCase()]
  if (named) return { keyCode: named, modifiers }
  // A single printable character is its own keyCode.
  if ([...keyPart].length === 1) return { keyCode: keyPart, modifiers }
  return null
}

/** Keys whose `char` event is what actually produces the effect (form submit,
 *  a space in a field, a tab move). Sending char for e.g. Escape would type a
 *  control character into the page. */
const NEEDS_CHAR = new Set(['Return', 'Space', 'Tab'])

export async function sendKey(target: InputTarget, key: ParsedKey, label: string): Promise<void> {
  emitAgentCursor(target.panelId, { kind: 'press', label })
  const { keyCode, modifiers } = key
  const mods = modifiers.length ? modifiers : undefined
  await target.webview.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods })
  // A modified key (cmd+a) is a shortcut, not text: emitting char would insert
  // the literal character alongside the shortcut.
  if (NEEDS_CHAR.has(keyCode) && !modifiers.length) {
    await target.webview.sendInputEvent({ type: 'char', keyCode, modifiers: mods })
  } else if (!modifiers.length && [...keyCode].length === 1) {
    await target.webview.sendInputEvent({ type: 'char', keyCode, modifiers: mods })
  }
  await target.webview.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods })
}

/** Type text one char event at a time — the only form that fires the
 *  keypress/beforeinput handlers real editors listen to. */
export async function sendText(target: InputTarget, text: string, label: string): Promise<void> {
  emitAgentCursor(target.panelId, { kind: 'type', label })
  for (const char of [...text]) {
    await target.webview.sendInputEvent({ type: 'char', keyCode: char })
  }
}

/** Clear the focused field, then type. Selection is done by the caller's focus
 *  script (select-all); Backspace deletes it in one step. */
export async function sendReplaceText(target: InputTarget, text: string, label: string): Promise<void> {
  emitAgentCursor(target.panelId, { kind: 'type', label })
  await target.webview.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
  await target.webview.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  for (const char of [...text]) {
    await target.webview.sendInputEvent({ type: 'char', keyCode: char })
  }
}

export interface ClickOptions {
  button?: 'left' | 'middle' | 'right'
  clickCount?: number
  modifiers?: PortalInputModifier[]
}

export async function sendClick(
  target: InputTarget,
  x: number,
  y: number,
  options: ClickOptions,
  cursor: Omit<AgentCursorEvent, 'x' | 'y'>,
): Promise<void> {
  const { button = 'left', clickCount = 1, modifiers } = options
  emitAgentCursor(target.panelId, { ...cursor, x, y })
  const mods = modifiers?.length ? modifiers : undefined
  // Move first: hover styles, tooltips and menus that open on pointerenter need
  // the pointer to arrive before the press, exactly like a real user.
  await target.webview.sendInputEvent({ type: 'mouseMove', x, y, modifiers: mods })
  await target.webview.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount, modifiers: mods })
  await target.webview.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount, modifiers: mods })
}

export async function sendHover(target: InputTarget, x: number, y: number, label: string, rect?: [number, number, number, number]): Promise<void> {
  emitAgentCursor(target.panelId, { kind: 'hover', x, y, rect, label })
  await target.webview.sendInputEvent({ type: 'mouseMove', x, y })
}

/** Press at one point, move in steps, release at another. The intermediate
 *  moves are required: HTML5 drag and most JS drag implementations start on
 *  movement, so a down/up pair at two points does nothing. */
export async function sendDrag(
  target: InputTarget,
  from: { x: number; y: number },
  to: { x: number; y: number },
  label: string,
  steps = 10,
): Promise<void> {
  emitAgentCursor(target.panelId, { kind: 'drag', x: from.x, y: from.y, toX: to.x, toY: to.y, label })
  await target.webview.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y })
  await target.webview.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let step = 1; step <= steps; step++) {
    const x = Math.round(from.x + ((to.x - from.x) * step) / steps)
    const y = Math.round(from.y + ((to.y - from.y) * step) / steps)
    await target.webview.sendInputEvent({ type: 'mouseMove', x, y })
  }
  await target.webview.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 })
}

export async function sendWheel(
  target: InputTarget,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
  label: string,
): Promise<void> {
  emitAgentCursor(target.panelId, { kind: 'scroll', x, y, label })
  await target.webview.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY })
}
