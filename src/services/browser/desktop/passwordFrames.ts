// Password detection runs in a named isolated world in every frame. No Node
// integration or callable bridge is exposed to the site's JavaScript.
import { installPasswordBridge } from './preload/passwordBridge'

const WORLD = 'cate-passwords'
const BINDING = '__catePasswordEvent'
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
type Send = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>
interface Context { id: number; frameId: string; sessionId?: string }

export class PasswordFrames {
  private readonly contexts = new Map<string, Context>()
  private readonly targets = new Map<string, Context & { origin: string }>()
  private focusRevision = 0

  constructor(private readonly deps: {
    send: Send
    offset(frameId: string): Promise<{ x: number; y: number }>
    emit(channel: 'focus' | 'submit', payload: unknown): void
    automated(): boolean
  }) {}

  async install(sessionId?: string): Promise<void> {
    await this.deps.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD }, sessionId)
    await this.deps.send('Page.addScriptToEvaluateOnNewDocument', {
      worldName: WORLD, runImmediately: true,
      source: `if (!globalThis.__catePasswordsInstalled) {
        globalThis.__catePasswordsInstalled = true;
        (${installPasswordBridge.toString()})((channel, payload) => globalThis.${BINDING}(JSON.stringify({channel, payload})), () => false);
      }`,
    }, sessionId)
  }

  clear(sessionId?: string): void {
    for (const [key, context] of this.contexts) if (!sessionId || context.sessionId === sessionId) this.contexts.delete(key)
    this.dismiss()
  }

  private dismiss(): void {
    this.focusRevision++
    this.targets.clear()
    this.deps.emit('focus', { dismiss: true })
  }

  handle(method: string, params: Record<string, unknown>, sessionId?: string): void {
    const key = (id: unknown) => `${sessionId ?? ''}:${id}`
    if (method === 'Runtime.executionContextCreated') {
      const context = object(params.context), aux = object(context.auxData)
      if (context.name === WORLD && typeof context.id === 'number' && typeof aux.frameId === 'string') {
        this.contexts.set(key(context.id), { id: context.id, frameId: aux.frameId, sessionId })
      }
    } else if (method === 'Runtime.executionContextDestroyed') {
      if (this.contexts.delete(key(params.executionContextId))) this.dismiss()
    } else if (method === 'Runtime.executionContextsCleared') {
      this.clear(sessionId)
    } else if (method === 'Runtime.bindingCalled' && params.name === BINDING) {
      const context = this.contexts.get(key(params.executionContextId))
      if (context && typeof params.payload === 'string') void this.receive(context, params.payload).catch(() => {})
    }
  }

  private async receive(context: Context, json: string): Promise<void> {
    const event = object(JSON.parse(json)), payload = object(event.payload)
    if (event.channel === 'cate-browser-password-submit') {
      // The payload comes only from our isolated-world listener, never a
      // page-authored postMessage. Keep the frame's own origin on the entry.
      this.deps.emit('submit', { ...payload, automated: this.deps.automated() })
    } else if (event.channel === 'cate-browser-password-focus') {
      this.dismiss()
      if (payload.dismiss) return
      const origin = typeof payload.origin === 'string' ? payload.origin : ''
      if (!/^https?:\/\//.test(origin) || typeof payload.targetId !== 'string') return
      const rect = object(payload.rect)
      if (![rect.left, rect.bottom, rect.width, rect.height].every(value => typeof value === 'number' && Number.isFinite(value))) return
      const revision = this.focusRevision
      const offset = await this.deps.offset(context.frameId)
      if (revision !== this.focusRevision) return
      this.targets.set(payload.targetId, { ...context, origin })
      this.deps.emit('focus', { ...payload, rect: { ...rect, left: Number(rect.left) + offset.x, bottom: Number(rect.bottom) + offset.y } })
    }
  }

  async resolve(targetId: string, origin: string): Promise<{ objectId: string; backendNodeId: number; frameId: string; sessionId?: string }> {
    const target = this.targets.get(targetId)
    if (!target || target.origin !== origin) throw new Error('credential-target-expired')
    const result = object((await this.deps.send('Runtime.evaluate', {
      expression: `location.origin === ${JSON.stringify(origin)} ? document.querySelector(${JSON.stringify(`[data-cate-autofill-target="${targetId}"]`)}) : null`,
      contextId: target.id, objectGroup: 'cate-browser', returnByValue: false,
    }, target.sessionId)).result)
    if (typeof result.objectId !== 'string' || !this.targets.has(targetId)) throw new Error('credential-target-expired')
    const node = object((await this.deps.send('DOM.describeNode', { objectId: result.objectId }, target.sessionId)).node)
    if (typeof node.backendNodeId !== 'number') throw new Error('credential-target-expired')
    return { objectId: result.objectId, backendNodeId: node.backendNodeId, frameId: target.frameId, sessionId: target.sessionId }
  }
}
