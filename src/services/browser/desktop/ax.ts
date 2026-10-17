import type { BrowserElement } from '../contract'

type CdpRecord = Record<string, unknown>
interface AXTarget { backendNodeId: number; frameId?: string; sessionId?: string }
export interface AXFrame {
  frameId?: string
  /** The CDP session of an out-of-process frame. */
  sessionId?: string
  /** The frame that holds this frame's <iframe>, and that frame's session. */
  parentFrameId?: string
  parentSessionId?: string
}
interface AXOptions {
  /** The main frame first. */
  frames: AXFrame[]
  /** The main frame's viewport in CSS pixels, and its device pixel ratio. */
  viewport: { width: number; height: number; deviceScaleFactor: number }
  send(method: string, params?: CdpRecord, sessionId?: string): Promise<CdpRecord>
  register(target: AXTarget): number
}
/** What the DOM snapshot says about one element. */
interface Inspection { visible: boolean; offscreen?: boolean; password?: boolean; file?: 'single' | 'multiple' }

const objectValue = (value: unknown): CdpRecord => value !== null && typeof value === 'object' ? value as CdpRecord : {}
const numbers = (value: unknown): number[] => Array.isArray(value) ? value as number[] : []
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'option',
  'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
])
// Unnamed containers only add depth and tokens; their children stay listed.
const UNNAMED_SKIPPED = new Set([
  'generic', 'none', 'presentation', 'paragraph', 'LabelText', 'LineBreak', 'Section',
  'MenuListPopup', 'group', 'listitem', 'list', 'DescriptionListDetail', 'DescriptionListTerm',
])
// Never worth a line: a list's bullets and numbers.
const ALWAYS_SKIPPED = new Set(['ListMarker'])
// Only states that tell the agent something; a false boolean is the default.
const STATE_PROPERTIES = ['checked', 'selected', 'expanded', 'disabled', 'required', 'readonly', 'pressed', 'level', 'focused']

/** Visibility, viewport and input type of every element of one CDP
 *  session's documents (its frame and the same-process frames inside it),
 *  from one `DOMSnapshot.captureSnapshot`. Bounds are device pixels of the
 *  element's own document. */
async function inspectSession(send: AXOptions['send'], sessionId: string | undefined, mainViewport: { width: number; height: number } | undefined): Promise<Map<number, Inspection>> {
  const snapshot = await send('DOMSnapshot.captureSnapshot', { computedStyles: ['visibility', 'opacity'] }, sessionId)
  const strings = Array.isArray(snapshot.strings) ? snapshot.strings as string[] : []
  const text = (index: unknown) => typeof index === 'number' && index >= 0 ? strings[index] ?? '' : ''
  const documents = Array.isArray(snapshot.documents) ? snapshot.documents.map(objectValue) : []
  const out = new Map<number, Inspection>()
  // A frame's viewport is its <iframe>'s box in the document holding it.
  const frameViewports = new Map<number, { width: number; height: number }>()
  const parsed = documents.map((doc, docIndex) => {
    const nodes = objectValue(doc.nodes)
    const layout = objectValue(doc.layout)
    const parent = numbers(nodes.parentIndex)
    const names = numbers(nodes.nodeName).map(text)
    const backend = numbers(nodes.backendNodeId)
    const attributes = (Array.isArray(nodes.attributes) ? nodes.attributes : []).map((pairs: unknown) => {
      const list = numbers(pairs)
      const map = new Map<string, string>()
      for (let i = 0; i + 1 < list.length; i += 2) map.set(text(list[i]).toLowerCase(), text(list[i + 1]))
      return map
    })
    const boxes = new Map<number, { rect: number[]; visibility: string; opacity: string }>()
    const layoutNodes = numbers(layout.nodeIndex)
    const bounds = Array.isArray(layout.bounds) ? layout.bounds as number[][] : []
    const styles = Array.isArray(layout.styles) ? layout.styles as number[][] : []
    layoutNodes.forEach((node, i) => {
      const [visibility, opacity] = (styles[i] ?? []).map(text)
      // A text or line box after its element's box must not replace it.
      if (!boxes.has(node)) boxes.set(node, { rect: bounds[i] ?? [], visibility: visibility ?? '', opacity: opacity ?? '' })
    })
    const content = objectValue(nodes.contentDocumentIndex)
    numbers(content.index).forEach((node, i) => {
      const rect = boxes.get(node)?.rect
      if (rect && rect.length >= 4) frameViewports.set(numbers(content.value)[i], { width: rect[2], height: rect[3] })
    })
    return { doc, docIndex, parent, names, backend, attributes, boxes }
  })
  for (const { doc, docIndex, parent, names, backend, attributes, boxes } of parsed) {
    const viewport = docIndex === 0 && mainViewport ? mainViewport : frameViewports.get(docIndex)
    const scrollX = Number(doc.scrollOffsetX ?? 0), scrollY = Number(doc.scrollOffsetY ?? 0)
    // An element is shown when it has a box, its visibility is visible and
    // neither it nor an ancestor is fully transparent (checkVisibility).
    const shown = (node: number): number[] | undefined => {
      const box = boxes.get(node)
      if (!box || box.rect.length < 4 || box.rect[2] <= 0 || box.rect[3] <= 0 || box.visibility !== 'visible') return undefined
      for (let at = node; at >= 0; at = parent[at]) if (boxes.get(at)?.opacity === '0') return undefined
      return box.rect
    }
    const labels = (node: number): number[] => {
      const found: number[] = []
      for (let at = parent[node]; at >= 0; at = parent[at]) if (names[at] === 'LABEL') { found.push(at); break }
      const id = attributes[node]?.get('id')
      if (id) names.forEach((name, at) => { if (name === 'LABEL' && attributes[at]?.get('for') === id) found.push(at) })
      return found
    }
    names.forEach((name, node) => {
      const type = name === 'INPUT' ? (attributes[node]?.get('type') ?? 'text').toLowerCase() : ''
      let rect = shown(node)
      // Styled checkboxes, radios and file inputs hide the native input behind a visible label.
      if (!rect && ['checkbox', 'radio', 'file'].includes(type)) {
        for (const label of labels(node)) { rect = shown(label); if (rect) break }
      }
      if (!rect) { out.set(backend[node], { visible: false }); return }
      const [x, y, width, height] = rect
      const left = x - scrollX, top = y - scrollY
      out.set(backend[node], {
        visible: true,
        offscreen: viewport ? !(top + height > 0 && left + width > 0 && top < viewport.height && left < viewport.width) : false,
        password: type === 'password',
        ...(type === 'file' ? { file: attributes[node]?.has('multiple') ? 'multiple' as const : 'single' as const } : {}),
      })
    })
  }
  return out
}

interface FrameLines {
  /** The <iframe> holding this frame, as `session:backendNodeId`. */
  owner?: string
  lines: Array<{ depth: number; text: string; target: string }>
}

/** The accessibility tree of the page and its frames as text, every frame's
 *  lines under its <iframe>, and the elements an agent can act on. */
export async function readBrowserAX({ frames, viewport, send, register }: AXOptions): Promise<{ state: string; elements: BrowserElement[] }> {
  const elements: BrowserElement[] = []
  const seen = new Set<string>()
  const inspections = new Map<string, Promise<Map<number, Inspection> | undefined>>()
  const inspect = (sessionId: string | undefined) => {
    const key = sessionId ?? 'root'
    let pending = inspections.get(key)
    if (!pending) {
      const scale = viewport.deviceScaleFactor || 1
      pending = inspectSession(send, sessionId, sessionId ? undefined : { width: viewport.width * scale, height: viewport.height * scale })
      // An out-of-process frame can go away mid-observation; the page cannot.
      if (sessionId) pending = pending.catch(() => undefined)
      inspections.set(key, pending)
    }
    return pending
  }
  const outputs: FrameLines[] = []
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const source = frames[frameIndex]
    let tree: CdpRecord
    try {
      tree = frameIndex === 0
        ? await send('Accessibility.getFullAXTree')
        : await send('Accessibility.getFullAXTree', source.sessionId ? {} : { frameId: source.frameId }, source.sessionId)
    } catch (error) {
      if (frameIndex === 0) throw error
      // A child frame can detach between Page.getFrameTree and its AX query.
      continue
    }
    const [inspection, owner] = await Promise.all([
      inspect(source.sessionId),
      frameIndex > 0 && source.frameId
        ? send('DOM.getFrameOwner', { frameId: source.frameId }, source.parentSessionId)
          .then(result => typeof result.backendNodeId === 'number' ? `${source.parentSessionId ?? 'root'}:${result.backendNodeId}` : undefined)
          .catch(() => undefined)
        : Promise.resolve(undefined),
    ])
    const nodes = Array.isArray(tree.nodes) ? tree.nodes.map(objectValue) : []
    const byId = new Map(nodes.map(node => [node.nodeId, node]))
    const ordered: CdpRecord[] = []
    const visited = new Set<CdpRecord>()
    const visit = (node: CdpRecord): void => {
      if (visited.has(node)) return
      visited.add(node)
      ordered.push(node)
      if (Array.isArray(node.childIds)) {
        for (const childId of node.childIds) {
          const child = byId.get(childId)
          if (child) visit(child)
        }
      }
    }
    for (const node of nodes) if (!byId.has(node.parentId)) visit(node)
    for (const node of nodes) visit(node)
    const output: FrameLines = { owner, lines: [] }
    const emitted = new Set<unknown>()
    for (const node of ordered) {
      const role = String(objectValue(node.role).value ?? '')
      const backendNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined
      if (!backendNodeId || !role || role === 'RootWebArea' || node.ignored === true || ALWAYS_SKIPPED.has(role)) continue
      const identity = `${source.sessionId ?? 'root'}:${backendNodeId}`
      if (seen.has(identity)) continue
      seen.add(identity)
      // Boxless controls cannot be clicked; offscreen controls remain usable.
      const found = INTERACTIVE_ROLES.has(role) ? inspection?.get(backendNodeId) : { visible: true }
      if (found?.visible !== true) continue
      const target = { backendNodeId, frameId: source.frameId, sessionId: source.sessionId }
      const name = String(objectValue(node.name).value ?? '')
      // The nearest listed ancestor sets the depth and, for text, whether it
      // only repeats that ancestor's name.
      let depth = 0
      let ownerText: string | undefined
      // A label's text is already the name of the control it labels.
      const labelText = String(objectValue(byId.get(node.parentId)?.role).value ?? '') === 'LabelText'
      let parent = byId.get(node.parentId)
      const ancestors = new Set<unknown>()
      while (parent && !ancestors.has(parent.nodeId)) {
        ancestors.add(parent.nodeId)
        if (emitted.has(parent.nodeId)) {
          depth += 1
          ownerText ??= `${String(objectValue(parent.name).value ?? '')}\n${String(objectValue(parent.value).value ?? '')}`
        }
        parent = byId.get(parent.parentId)
      }
      if (!name.trim() && UNNAMED_SKIPPED.has(role)) continue
      if (role === 'StaticText' && (!name.trim() || labelText || ownerText?.includes(name.trim()))) continue
      const offscreen = found.offscreen === true
      const id = register(target)
      let value = objectValue(node.value).value
      // Unknown type is fail-closed: never expose a potentially protected value.
      if ((role === 'textbox' || role === 'searchbox') && found.password !== false) value = '••••••••'
      const states: CdpRecord = {}
      let suffix = value === undefined || value === '' ? '' : ` value=${JSON.stringify(value)}`
      if (Array.isArray(node.properties)) {
        for (const raw of node.properties) {
          const property = objectValue(raw)
          const key = String(property.name)
          if (!STATE_PROPERTIES.includes(key)) continue
          const state = objectValue(property.value).value
          if (state === undefined) continue
          states[key] = state
          if (state === true || state === 'true') suffix += ` [${key}]`
          else if (key === 'expanded' && (state === false || state === 'false')) suffix += ' [collapsed]'
          else if (state !== false && state !== 'false') suffix += ` [${key}=${typeof state === 'string' ? state : JSON.stringify(state)}]`
        }
      }
      // A file input reads as a button: say what it takes (`cate browser upload`).
      if (found.file === 'single' || found.file === 'multiple') {
        states.file = found.file
        suffix += found.file === 'multiple' ? ' [file input, multiple]' : ' [file input]'
      }
      if (offscreen) suffix += ' [offscreen]'
      elements.push({ id, role, name, ...(value === undefined ? {} : { value }), ...(Object.keys(states).length ? { states } : {}), ...(offscreen ? { offscreen: true } : {}) })
      if (node.nodeId !== undefined) emitted.add(node.nodeId)
      output.lines.push({ depth, target: identity, text: `${role}${name ? ` ${JSON.stringify(name)}` : ''}${suffix} [id=${id}]` })
    }
    outputs.push(output)
  }
  // Each frame's lines go under its <iframe>; a frame whose <iframe> is not
  // listed goes at the end.
  const lines: string[] = []
  const placed = new Set<FrameLines>()
  const print = (frame: FrameLines, base: number): void => {
    placed.add(frame)
    for (const line of frame.lines) {
      lines.push(`${'  '.repeat(base + line.depth)}- ${line.text}`)
      for (const child of outputs) if (!placed.has(child) && child.owner === line.target) print(child, base + line.depth + 1)
    }
  }
  for (const frame of outputs) if (!placed.has(frame)) print(frame, 0)
  return { state: lines.join('\n'), elements }
}
