// Human-readable output for `cate` results, chosen by the spec's `format` id.
// `--json` bypasses all of this.

import { describeBrowserObservation, type BrowserObservation } from '@services/browser/contract'

const SHORT_ID = 8

function shortId(id: string): string {
  return id.length > SHORT_ID ? id.slice(0, SHORT_ID) : id
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

const isScalar = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value)

/** Scalars as text; a flat object as aligned `key  value` lines; anything
 *  nested as indented JSON. */
function generic(value: unknown): string {
  if (value === undefined || value === null) return 'ok'
  if (isScalar(value)) return String(value)
  const object = asObject(value)
  if (!object || Array.isArray(object)) return JSON.stringify(value, null, 2)
  if (typeof object.path === 'string') return object.path
  const entries = Object.entries(object)
  if (entries.length === 0 || (entries.length === 1 && object.ok === true)) return 'ok'
  const flat = entries.every(([, v]) => isScalar(v) || (Array.isArray(v) && v.every(isScalar)))
  if (!flat) return JSON.stringify(value, null, 2)
  const width = Math.max(...entries.map(([key]) => key.length)) + 2
  return entries
    .map(([key, v]) => `${key.padEnd(width)}${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('\n')
}

/** Rows under a header, each column padded to its widest cell. */
function table(header: readonly string[], rows: readonly string[][]): string {
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i].length)))
  const line = (cells: readonly string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value))

function panelList(value: unknown): string {
  if (!Array.isArray(value)) return generic(value)
  if (value.length === 0) return '(no panels)'
  return table(['', 'ID', 'TYPE', 'TITLE'], value.map((item) => {
    const panel = asObject(item) ?? {}
    return [panel.focused ? '*' : '', shortId(text(panel.panelId) || '?'), text(panel.type), text(panel.filePath ?? panel.url ?? panel.title)]
  }))
}

function agentRuns(value: unknown): string {
  if (!Array.isArray(value)) return generic(value)
  if (value.length === 0) return '(no agent runs)'
  return table(['ID', 'STATE', 'TITLE'], value.map((item) => {
    const run = asObject(item) ?? {}
    return [shortId(text(run.panelId ?? run.id) || '?'), text(run.state ?? run.status) || '?', text(run.title ?? run.agentName ?? run.agentId)]
  }))
}

function conversation(value: unknown): string {
  const object = asObject(value)
  if (!object || !Array.isArray(object.messages)) return generic(value)
  const label = [object.agentName, object.title].filter(Boolean).join(' · ')
  const header = `${shortId(String(object.panelId ?? '?'))}\t${object.state ?? '?'}${label ? `\t${label}` : ''}`
  const messages = object.messages.map((item) => {
    const message = asObject(item)
    if (!message) return String(item)
    const meta = [message.role ?? '?', message.createdAt].filter(Boolean).join(' · ')
    return `[${meta}]\n${message.text ?? ''}`
  })
  return [header, ...(messages.length > 0 ? messages : ['(no messages)'])].join('\n\n')
}

function browserContent(value: unknown): string {
  const content = asObject(value)?.content
  if (!Array.isArray(content)) return generic(value)
  return content.map((item) => {
    const block = asObject(item)
    if (block?.type === 'text') return String(block.text ?? '')
    if (typeof block?.path === 'string') {
      return `Screenshot: ${block.path}\n${SCREENSHOT_NOTE}`
    }
    return '[Browser image: use --json for image data]'
  }).join('\n')
}

const SCREENSHOT_NOTE = 'Open this file with your image-viewing tool to inspect the page visually.'

/** A page operation's result: an observation, an action with the observation
 *  after it, or a plain value (an attribute). */
function browserObservation(value: unknown): string {
  const object = asObject(value)
  const observation = asObject(object?.observation) ?? (typeof object?.observationId === 'string' ? object : null)
  if (!observation) return value === null ? '(none)' : generic(value)
  const action = asObject(object?.action) as { method: string; status: string } | null
  const text = describeBrowserObservation(observation as unknown as BrowserObservation, action ?? undefined)
  const shot = asObject(observation.screenshot)
  return typeof shot?.path === 'string' ? `${text}\nScreenshot: ${shot.path}\n${SCREENSHOT_NOTE}` : text
}

function browserTabs(value: unknown): string {
  const tabs = asObject(value)?.tabs
  if (!Array.isArray(tabs)) return generic(value)
  if (tabs.length === 0) return '(no tabs)'
  return table(['', 'PANEL', 'TAB', 'URL', 'TITLE'], tabs.map((item) => {
    const tab = asObject(item) ?? {}
    return [tab.active ? '*' : '', shortId(text(tab.panelId)), text(tab.tabId), text(tab.url), text(tab.title)]
  }))
}

const FORMATTERS: Record<string, (value: unknown) => string> = {
  panelList,
  agentRuns,
  agentWait: (value) => {
    const result = asObject(value)
    const runs = agentRuns(result?.agents)
    return result?.timedOut === true ? `${runs}\n(timed out before every agent was ready)` : runs
  },
  conversation,
  browserContent,
  browserObservation,
  browserTabs,
  prettyJson: (value) => JSON.stringify(value, null, 2),
  terminalText: (value) => {
    const text = asObject(value)?.text
    return typeof text === 'string' ? text : generic(value)
  },
  createdPanel: (value) => {
    const panelId = asObject(value)?.panelId
    return typeof panelId === 'string' ? shortId(panelId) : generic(value)
  },
  panelTarget: (value) => {
    const panelId = asObject(value)?.panelId
    return typeof panelId === 'string' ? shortId(panelId) : '(no panel selected)'
  },
}

export function formatOutput(format: string | undefined, value: unknown): string {
  const formatter = format ? FORMATTERS[format] : undefined
  return formatter ? formatter(value) : generic(value)
}

/** Where human output puts what is too big or binary to print. */
export interface OutputFiles {
  /** Saves a base64 PNG and returns its path. */
  image?: (base64: string) => Promise<string>
  /** Saves text and returns its path. */
  text?: (text: string) => Promise<string>
}

/** Text longer than this goes to a file; the output keeps its head. */
const SPILL_CHARS = 12_000
const SPILL_HEAD_CHARS = 6_000

async function spill(text: string, files: OutputFiles): Promise<string> {
  if (text.length <= SPILL_CHARS || !files.text) return text
  const path = await files.text(text)
  const cut = text.lastIndexOf('\n', SPILL_HEAD_CHARS)
  const head = text.slice(0, cut > 0 ? cut : SPILL_HEAD_CHARS)
  const more = text.split('\n').length - head.split('\n').length
  return `${head}\n... ${more} more lines. The full text is in ${path}; search it (rg, grep) for what you need instead of printing it all.`
}

/** Saves browser images and long browser text to files, so the human output
 *  prints their paths. */
export async function prepareOutput(format: string | undefined, value: unknown, files: OutputFiles): Promise<void> {
  if (format === 'browserObservation') {
    const object = asObject(value)
    const observation = asObject(object?.observation) ?? (typeof object?.observationId === 'string' ? object : null)
    if (!observation) return
    const shot = asObject(observation.screenshot)
    if (shot && typeof shot.data === 'string' && files.image) shot.path = await files.image(shot.data)
    if (typeof observation.state === 'string') observation.state = await spill(observation.state, files)
    return
  }
  if (format !== 'browserContent') return
  const content = asObject(value)?.content
  if (!Array.isArray(content)) return
  for (const item of content) {
    const block = asObject(item)
    if (block?.type === 'image' && typeof block.data === 'string' && files.image) block.path = await files.image(block.data)
    if (block?.type === 'text' && typeof block.text === 'string') block.text = await spill(block.text, files)
  }
}
