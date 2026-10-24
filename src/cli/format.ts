// Human-readable output for `cate` results, chosen by the spec's `format` id.
// `--json` bypasses all of this.

import {
  describeBrowserAction,
  describeBrowserElement,
  describeBrowserConsole,
  describeBrowserNetwork,
  describeBrowserObservation,
  type BrowserActionOutcome,
  type BrowserDownloadEntry,
  type BrowserElement,
  type BrowserObservation,
} from '@services/browser/contract'

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

/** An agent panel's prompts on their way, by state (`1 queued, 1 failed`). */
function promptCounts(prompts: unknown): string {
  if (!Array.isArray(prompts)) return ''
  const counts = new Map<string, number>()
  for (const prompt of prompts) {
    const state = text(asObject(prompt)?.state) || '?'
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  return [...counts].map(([state, count]) => `${count} ${state}`).join(', ')
}

function agentRuns(value: unknown): string {
  if (!Array.isArray(value)) return generic(value)
  if (value.length === 0) return '(no agent runs)'
  return table(['ID', 'STATE', 'PROMPTS', 'TITLE'], value.map((item) => {
    const run = asObject(item) ?? {}
    return [shortId(text(run.panelId ?? run.id) || '?'), text(run.state ?? run.status) || '?', promptCounts(run.prompts), text(run.title ?? run.agentName ?? run.agentId)]
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
  // Prompts on their way: queued, being sent, or not taken with why.
  const prompts = (Array.isArray(object.prompts) ? object.prompts : []).map((item) => {
    const prompt = asObject(item) ?? {}
    const meta = ['prompt', text(prompt.state), shortId(text(prompt.id))].filter(Boolean).join(' · ')
    return `[${meta}]\n${text(prompt.text)}${prompt.error ? `\n(${text(prompt.error)})` : ''}`
  })
  return [header, ...(messages.length > 0 ? messages : ['(no messages)']), ...prompts].join('\n\n')
}

const SCREENSHOT_NOTE = 'Open this file with your image-viewing tool to inspect the page visually.'

/** A page operation's result: an observation, an action with the observation
 *  after it, or a plain value (an attribute). */
function browserObservation(value: unknown): string {
  const object = asObject(value)
  const observation = asObject(object?.observation) ?? (typeof object?.observationId === 'string' ? object : null)
  const action = asObject(object?.action) as BrowserActionOutcome | null
  // An action a dialog interrupted has no observation: the page is waiting.
  if (!observation) return action ? describeBrowserAction(action) : value === null ? '(none)' : generic(value)
  const text = describeBrowserObservation(observation as unknown as BrowserObservation, action ?? undefined)
  const shot = asObject(observation.screenshot)
  return typeof shot?.path === 'string' ? `${text}\nScreenshot: ${shot.path}\n${SCREENSHOT_NOTE}` : text
}

function browserTabs(value: unknown): string {
  const tabs = asObject(value)?.tabs
  if (!Array.isArray(tabs)) return generic(value)
  if (tabs.length === 0) return '(no tabs)'
  return table(['', 'PANEL', 'TAB', 'OPENED BY', 'URL', 'TITLE'], tabs.map((item) => {
    const tab = asObject(item) ?? {}
    return [tab.active ? '*' : '', shortId(text(tab.panelId)), text(tab.tabId), text(tab.opener), text(tab.url), text(tab.title)]
  }))
}

/** `cate browser find`: the matching elements as snapshot lines. */
function browserElements(value: unknown): string {
  const elements = asObject(value)?.elements
  if (!Array.isArray(elements)) return generic(value)
  if (elements.length === 0) return '(no matching elements)'
  return (elements as BrowserElement[]).map(describeBrowserElement).join('\n')
}

function browserDownloads(value: unknown): string {
  const downloads = asObject(value)?.downloads
  if (!Array.isArray(downloads)) return generic(value)
  if (downloads.length === 0) return '(no downloads)'
  return table(['STATE', 'FILE', 'PATH'], (downloads as BrowserDownloadEntry[]).map((entry) => [text(entry.state), text(entry.filename), text(entry.filePath)]))
}

/** Console messages or requests, with how many matched when not all are shown. */
function browserLog<T>(describe: (entries: T[]) => string) {
  return (value: unknown): string => {
    const object = asObject(value)
    if (!Array.isArray(object?.entries)) return generic(value)
    const text = describe(object.entries as T[])
    const total = typeof object.total === 'number' ? object.total : object.entries.length
    return total > object.entries.length ? `${text}\n(the last ${object.entries.length} of ${total}; --limit shows more)` : text
  }
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
  browserObservation,
  browserTabs,
  browserElements,
  browserDownloads,
  browserConsole: browserLog(describeBrowserConsole),
  browserNetwork: browserLog(describeBrowserNetwork),
  prettyJson: (value) => JSON.stringify(value, null, 2),
  terminalText: (value) => {
    const text = asObject(value)?.text
    return typeof text === 'string' ? text : generic(value)
  },
  createdPanel: (value) => {
    const panelId = asObject(value)?.panelId
    return typeof panelId === 'string' ? shortId(panelId) : generic(value)
  },
  promptId: (value) => {
    const promptId = asObject(value)?.promptId
    return typeof promptId === 'string' ? promptId : generic(value)
  },
  withdrawnPrompt: (value) => {
    const prompt = asObject(value)?.prompt
    return typeof prompt === 'string' ? prompt : generic(value)
  },
  panelTarget: (value) => {
    const panelId = asObject(value)?.panelId
    return typeof panelId === 'string' ? shortId(panelId) : '(no panel selected)'
  },
}

/** A result's `notices` (what changed in the browser panel's tabs since the
 *  last call), printed above the result itself. */
function splitNotices(value: unknown): { value: unknown; notices: string[] } {
  const object = asObject(value)
  if (!object || !Array.isArray(object.notices) || !object.notices.every((notice) => typeof notice === 'string')) return { value, notices: [] }
  const { notices, ...rest } = object
  const keys = Object.keys(rest)
  return { value: keys.length === 1 && keys[0] === 'value' ? rest.value : rest, notices: notices as string[] }
}

export function formatOutput(format: string | undefined, value: unknown): string {
  const { value: shown, notices } = splitNotices(value)
  const formatter = format ? FORMATTERS[format] : undefined
  const text = formatter ? formatter(shown) : generic(shown)
  return notices.length ? [...notices, text].join('\n') : text
}

/** Where human output puts what is too big or binary to print. */
export interface OutputFiles {
  /** Saves a base64 image of `mimeType` and returns its path. */
  image?: (base64: string, mimeType: unknown) => Promise<string>
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
  if (format !== 'browserObservation') return
  const object = asObject(value)
  const observation = asObject(object?.observation) ?? (typeof object?.observationId === 'string' ? object : null)
  if (!observation) return
  const shot = asObject(observation.screenshot)
  if (shot && typeof shot.data === 'string' && files.image) shot.path = await files.image(shot.data, shot.mimeType)
  if (typeof observation.state === 'string') observation.state = await spill(observation.state, files)
}
