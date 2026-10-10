import type { BrowserElement } from '../contract'

type CdpRecord = Record<string, unknown>
interface AXTarget { backendNodeId: number; frameId?: string; sessionId?: string }
interface AXOptions {
  frames: Array<{ frameId?: string; sessionId?: string }>
  send(method: string, params?: CdpRecord, sessionId?: string): Promise<CdpRecord>
  callOn(target: AXTarget, functionDeclaration: string): Promise<CdpRecord>
  register(target: AXTarget): number
}
const objectValue = (value: unknown): CdpRecord => value !== null && typeof value === 'object' ? value as CdpRecord : {}
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'option',
  'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
])
// Unnamed containers only add depth and tokens; their children stay listed.
const UNNAMED_SKIPPED = new Set([
  'generic', 'none', 'presentation', 'paragraph', 'LabelText', 'LineBreak', 'Section',
  'MenuListPopup', 'group', 'listitem', 'list', 'DescriptionListDetail', 'DescriptionListTerm',
])
// Only states that tell the agent something; a false boolean is the default.
const STATE_PROPERTIES = ['checked', 'selected', 'expanded', 'disabled', 'required', 'readonly', 'pressed', 'level', 'focused']
const INSPECT_ELEMENT = `function () {
  if (!(this instanceof Element)) return { visible: false };
  const boxes = element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ? Array.from(element.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0) : [];
  let rects = boxes(this);
  // Styled checkboxes and radios hide the native input behind a visible label.
  if (!rects.length && this instanceof HTMLInputElement && (this.type === 'checkbox' || this.type === 'radio')) {
    for (const label of this.labels || []) { rects = boxes(label); if (rects.length) break; }
  }
  if (!rects.length) return { visible: false };
  return {
    visible: true,
    offscreen: !rects.some(rect => rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth),
    password: this instanceof HTMLInputElement && this.type.toLowerCase() === 'password'
  };
}`

/** Inspect in parallel, but publish targets only after every worker has drained. */
export async function readBrowserAX({ frames, send, callOn, register }: AXOptions): Promise<{ state: string; elements: BrowserElement[] }> {
  const elements: BrowserElement[] = []
  const lines: string[] = []
  const seen = new Set<string>()
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
    const candidates = ordered.flatMap(node => {
      const role = String(objectValue(node.role).value ?? '')
      const backendNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined
      if (!backendNodeId || !role || role === 'RootWebArea' || node.ignored === true) return []
      const identity = `${source.sessionId ?? 'root'}:${backendNodeId}`
      if (seen.has(identity)) return []
      seen.add(identity)
      return [{ node, role, target: { backendNodeId, frameId: source.frameId, sessionId: source.sessionId } }]
    })
    const inspections: Array<CdpRecord | undefined> = new Array(candidates.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < candidates.length) {
        const index = next++
        const candidate = candidates[index]
        if (!INTERACTIVE_ROLES.has(candidate.role)) {
          inspections[index] = { visible: true }
          continue
        }
        try {
          // One isolated-world call checks visibility, viewport and password type.
          // Boxless controls cannot be clicked; offscreen controls remain usable.
          inspections[index] = objectValue((await callOn(candidate.target, INSPECT_ELEMENT)).value)
        } catch {
          // Nodes and frames may disappear during an observation.
        }
      }
    }
    // allSettled ensures cleanup cannot race another worker's outstanding CDP call.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(8, candidates.length) }, worker))
    for (const result of workers) if (result.status === 'rejected') throw result.reason
    const emitted = new Set<unknown>()
    for (let index = 0; index < candidates.length; index++) {
      const inspection = inspections[index]
      if (inspection?.visible !== true) continue
      const { node, role, target } = candidates[index]
      const name = String(objectValue(node.name).value ?? '')
      // The nearest listed ancestor sets the depth and, for text, whether it
      // only repeats that ancestor's name.
      let depth = 0
      let owner: string | undefined
      // A label's text is already the name of the control it labels.
      const labelText = String(objectValue(byId.get(node.parentId)?.role).value ?? '') === 'LabelText'
      let parent = byId.get(node.parentId)
      const ancestors = new Set<unknown>()
      while (parent && !ancestors.has(parent.nodeId)) {
        ancestors.add(parent.nodeId)
        if (emitted.has(parent.nodeId)) {
          depth += 1
          owner ??= `${String(objectValue(parent.name).value ?? '')}\n${String(objectValue(parent.value).value ?? '')}`
        }
        parent = byId.get(parent.parentId)
      }
      if (!name.trim() && UNNAMED_SKIPPED.has(role)) continue
      if (role === 'StaticText' && (!name.trim() || labelText || owner?.includes(name.trim()))) continue
      const offscreen = inspection.offscreen === true
      const id = register(target)
      let value = objectValue(node.value).value
      // Unknown type is fail-closed: never expose a potentially protected value.
      if ((role === 'textbox' || role === 'searchbox') && inspection.password !== false) value = '••••••••'
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
      if (offscreen) suffix += ' [offscreen]'
      elements.push({ id, role, name, ...(value === undefined ? {} : { value }), ...(Object.keys(states).length ? { states } : {}), ...(offscreen ? { offscreen: true } : {}) })
      if (node.nodeId !== undefined) emitted.add(node.nodeId)
      lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${suffix} [id=${id}]`)
    }
  }
  return { state: lines.join('\n'), elements }
}
