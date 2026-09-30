// Human-readable output for `cate` results, chosen by the spec's `format` id.
// `--json` bypasses all of this.

const SHORT_ID = 8

function shortId(id: string): string {
  return id.length > SHORT_ID ? id.slice(0, SHORT_ID) : id
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function generic(value: unknown): string {
  if (value === undefined || value === null) return 'ok'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const object = asObject(value)
  if (object && typeof object.path === 'string') return object.path
  return JSON.stringify(value)
}

function panelList(value: unknown): string {
  if (!Array.isArray(value)) return generic(value)
  return value.map((item) => {
    const panel = asObject(item)
    if (!panel) return String(item)
    const label = panel.filePath ?? panel.url ?? panel.title ?? ''
    return `${panel.focused ? '*' : ' '} ${shortId(String(panel.panelId ?? '?'))}\t${panel.type ?? '?'}${label ? `\t${label}` : ''}`
  }).join('\n') || '(no panels)'
}

function agentRuns(value: unknown): string {
  if (!Array.isArray(value)) return generic(value)
  return value.map((item) => {
    const run = asObject(item)
    if (!run) return String(item)
    const title = run.title ?? run.agentName ?? run.agentId ?? ''
    return `${shortId(String(run.panelId ?? run.id ?? '?'))}\t${run.state ?? run.status ?? '?'}${title ? `\t${title}` : ''}`
  }).join('\n') || '(no agent runs)'
}

function conversation(value: unknown): string {
  const object = asObject(value)
  if (!object || !Array.isArray(object.messages)) return generic(value)
  const label = [object.agentName, object.title].filter(Boolean).join(' · ')
  const header = `${shortId(String(object.panelId ?? '?'))}\t${object.state ?? '?'}${label ? `\t${label}` : ''}`
  const messages = object.messages.map((item) => {
    const message = asObject(item)
    if (!message) return String(item)
    const meta = [message.role ?? '?', message.createdAt, message.streaming ? 'streaming' : undefined].filter(Boolean).join(' · ')
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
      return `Screenshot: ${block.path}\nOpen this file with your image-viewing tool to inspect the page visually.`
    }
    return '[Browser image: use --json for image data]'
  }).join('\n')
}

const FORMATTERS: Record<string, (value: unknown) => string> = {
  panelList,
  agentRuns,
  agentWait: (value) => agentRuns(asObject(value)?.agents),
  agentRun: (value) => (asObject(value) ? agentRuns([value]) : generic(value)),
  conversation,
  browserContent,
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

/** Saves browser images to files so the human output can print their paths. */
export async function prepareOutput(
  format: string | undefined,
  value: unknown,
  writeImage: ((base64: string) => Promise<string>) | undefined,
): Promise<void> {
  if (format !== 'browserContent' || !writeImage) return
  const content = asObject(value)?.content
  if (!Array.isArray(content)) return
  for (const item of content) {
    const block = asObject(item)
    if (block?.type === 'image' && typeof block.data === 'string') block.path = await writeImage(block.data)
  }
}
