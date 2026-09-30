// The `cate` API router (architecture 14). Runs in the runtime next to the
// document. Every caller (the CLI, a T3 harness, a browser code cell, a
// client through the `api` capability) comes through `call`: the method is
// looked up in the specs, gated for CLI and harness callers, its arguments
// validated, its target resolved, and it runs on the owning service or the
// target panel's session within the spec's timeout.

import { RpcError } from '@kernel/rpc/contract'
import {
  ArgError,
  TARGET_ARG,
  cateApiTimeoutMs,
  cliAccessDenied,
  indexCateApi,
  isGatedCaller,
  validateCateArgs,
  type AnyArgSchema,
  type ApiCaller,
  type ApiHandlerContext,
  type ApiSessionContext,
  type ApiStickyTarget,
  type CateApiMethod,
  type CateApiNamespace,
  type CateServiceHandlers,
} from '../contract'
import {
  resolvePanelRef,
  resolveTarget,
  type ApiDocumentReader,
  type ApiPresenceReader,
} from './targets'
import type { ApiTokenRegistry } from './tokens'

/** Runs `session` methods on panel sessions. Throws `gone` when the panel has
 *  no session. `method` is the name inside the namespace (`note.add`). */
export interface ApiSessionHost {
  handleApi(panelId: string, method: string, args: Record<string, unknown>, ctx: ApiSessionContext): Promise<unknown>
}

/** Reads workspace settings (the `cli*Enabled` keys). */
export interface ApiSettingsReader {
  get(key: string): unknown
}

export type ServiceHandler = (args: Record<string, unknown>, ctx: ApiHandlerContext) => unknown

export interface ApiRouterOptions {
  namespaces: readonly CateApiNamespace<any>[]
  document: ApiDocumentReader
  presence: ApiPresenceReader
  sessions: ApiSessionHost
  settings: ApiSettingsReader
  tokens: ApiTokenRegistry
}

export interface ApiCallOptions {
  signal?: AbortSignal
}

export class ApiRouter {
  private readonly methods: Map<string, CateApiMethod>
  private readonly services = new Map<string, ServiceHandler>()
  private readonly sticky = new Map<string, string>()

  constructor(private readonly options: ApiRouterOptions) {
    this.methods = indexCateApi(options.namespaces)
    options.tokens.onRevoke((caller) => this.forget(caller.id))
  }

  /** The caller a token names, or undefined for an unknown token. */
  callerForToken(token: string | undefined): ApiCaller | undefined {
    return this.options.tokens.resolve(token)
  }

  /** A connected client calling through the `api` capability. */
  clientCaller(clientId: string): ApiCaller {
    return { kind: 'client', id: `client:${clientId}`, clientId }
  }

  /** Drops per-caller state (the sticky target). */
  forget(callerId: string): void {
    this.sticky.delete(callerId)
  }

  /** Registers a module's handlers for the `service` methods of a namespace. */
  registerService<N extends CateApiNamespace<any>>(namespace: N, handlers: CateServiceHandlers<N>): () => void {
    const entries = Object.entries(handlers as Record<string, ServiceHandler>)
    for (const [name] of entries) {
      const method = (namespace.methods as Record<string, CateApiMethod>)[name]
      if (!method || method.handler !== 'service') throw new Error(`not a service method: ${namespace.namespace}.${name}`)
      if (this.services.has(method.method)) throw new Error(`service handler already registered: ${method.method}`)
    }
    const names: string[] = []
    for (const [name, handler] of entries) {
      const method = (namespace.methods as Record<string, CateApiMethod>)[name]
      this.services.set(method.method, handler)
      names.push(method.method)
    }
    return () => {
      for (const name of names) this.services.delete(name)
    }
  }

  async call(caller: ApiCaller, methodName: string, rawArgs: unknown, options: ApiCallOptions = {}): Promise<unknown> {
    const method = this.methods.get(methodName)
    if (!method) throw new RpcError('unsupported', `unknown method: ${methodName}`)

    if (isGatedCaller(caller)) {
      const denied = cliAccessDenied(method.area, method.access, (key) => this.options.settings.get(key))
      if (denied) throw new RpcError('rejected', denied, { reason: 'permission' })
    }

    if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
      throw new RpcError('rejected', 'invalid arguments: expected an object')
    }
    let input = { ...(rawArgs as Record<string, unknown> | undefined) }
    let explicit: string | undefined
    if (method.handler === 'session') {
      const value = input[TARGET_ARG]
      if (value !== undefined && typeof value !== 'string') throw new RpcError('rejected', `invalid ${TARGET_ARG}: expected a string`)
      explicit = value || undefined
      const { [TARGET_ARG]: _target, ...rest } = input
      input = rest
    }

    let args: Record<string, unknown>
    try {
      args = validateCateArgs(method, input)
    } catch (err) {
      if (err instanceof ArgError) throw new RpcError('rejected', err.message)
      throw err
    }
    args = this.resolvePanelArgs(method, args)

    const sticky = this.stickyFor(caller)
    const controller = new AbortController()
    const ctx: ApiHandlerContext = {
      caller,
      method: method.method,
      signal: controller.signal,
      sticky,
      defaultTarget: (type) => {
        try {
          return resolveTarget({ ...this.targetReaders(), type, policy: 'auto', caller, sticky })
        } catch {
          return undefined
        }
      },
      invoke: (nested, nestedArgs) => this.call(caller, nested, nestedArgs ?? {}, { signal: controller.signal }),
    }

    let run: () => Promise<unknown>
    if (method.handler === 'session') {
      const panelId = resolveTarget({
        ...this.targetReaders(),
        type: method.panelType!,
        policy: method.target ?? 'auto',
        explicit,
        caller,
        sticky,
      })
      const sessionCtx: ApiSessionContext = { ...ctx, panelId }
      run = () => this.options.sessions.handleApi(panelId, method.name, args, sessionCtx)
    } else {
      const handler = this.services.get(method.method)
      if (!handler) throw new RpcError('unsupported', `${method.method} has no handler in this runtime`)
      run = async () => handler(args, ctx)
    }

    return withTimeout(run, cateApiTimeoutMs(method, args), controller, options.signal, method.method)
  }

  private targetReaders(): { document: ApiDocumentReader; presence: ApiPresenceReader } {
    return { document: this.options.document, presence: this.options.presence }
  }

  private stickyFor(caller: ApiCaller): ApiStickyTarget {
    return {
      get: () => this.sticky.get(caller.id),
      set: (panelId) => { this.sticky.set(caller.id, panelId) },
      clear: () => { this.sticky.delete(caller.id) },
    }
  }

  /** Turns panel id prefixes in `panel` arguments into full ids. */
  private resolvePanelArgs(method: CateApiMethod, args: Record<string, unknown>): Record<string, unknown> {
    let out = args
    for (const [key, schema] of Object.entries(method.args) as [string, AnyArgSchema][]) {
      const value = args[key]
      if (value === undefined) continue
      const def = schema.def
      if (def.kind === 'panel') {
        out = { ...out, [key]: resolvePanelRef(this.options.document, value as string, def.panelType).id }
      } else if (def.kind === 'array' && def.item?.def.kind === 'panel') {
        const type = def.item.def.panelType
        out = { ...out, [key]: (value as string[]).map((ref) => resolvePanelRef(this.options.document, ref, type).id) }
      }
    }
    return out
  }
}

async function withTimeout(
  run: () => Promise<unknown>,
  timeoutMs: number,
  controller: AbortController,
  outer: AbortSignal | undefined,
  method: string,
): Promise<unknown> {
  if (outer?.aborted) throw new RpcError('timeout', `${method}: cancelled`)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onOuterAbort: (() => void) | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RpcError('timeout', `${method}: no answer within ${timeoutMs} ms`))
    }, timeoutMs)
    onOuterAbort = () => {
      controller.abort()
      reject(new RpcError('timeout', `${method}: cancelled`))
    }
    outer?.addEventListener('abort', onOuterAbort, { once: true })
  })
  try {
    return await Promise.race([run(), expired])
  } catch (err) {
    if (err instanceof ArgError) throw new RpcError('rejected', err.message)
    throw err
  } finally {
    clearTimeout(timer)
    if (onOuterAbort) outer?.removeEventListener('abort', onOuterAbort)
  }
}
