// `defineCateApi`: each module declares its `cate.<namespace>.*` methods once.
// The declaration is the single source for dispatch, permissions, timeouts,
// CLI commands, help and argument parsing (architecture 14).

import { RpcError } from '@kernel/rpc/contract'
import type { ApiAccess, CliPermissionArea } from './permissions'
import { validateShape, type AnyArgSchema, type ArgShape, type InArgs, type OutArgs } from './schema'

/** How long the router waits for a handler unless the spec says otherwise. */
export const DEFAULT_API_TIMEOUT_MS = 10_000

/** The reserved argument naming a session method's target panel. */
export const TARGET_ARG = 'panelId'

/**
 * How far target resolution may go for a `session` method when the caller
 * names no panel:
 * - `explicit`: only an explicit id.
 * - `sticky`: an explicit id or the caller's sticky target.
 * - `auto`: then the caller's placement group, then the active panel of the
 *   most recently active client, then the only panel of the type.
 */
export type TargetPolicy = 'explicit' | 'sticky' | 'auto'

// Method syntax keeps the parameter bivariant, so a spec typed for its own
// arguments still fits the generic method table.
type TimeoutFn<S extends ArgShape> = { fn(args: OutArgs<S>): number }['fn']

export interface CateApiCliSpec<S extends ArgShape> {
  /** Command words. Defaults to the namespace followed by the method name split
   *  on dots (`review.note.add` is `cate review note add`). `false` keeps the
   *  method off the CLI (called by code cells or clients only). */
  command?: readonly string[] | false
  /** Pure adjustment after parsing, before validation (for example splitting
   *  `path:line:column`). */
  transform?: (args: Partial<InArgs<S>> & Record<string, unknown>) => Record<string, unknown>
}

export interface CateApiMethodSpec<S extends ArgShape = ArgShape> {
  access: ApiAccess
  handler: 'service' | 'session'
  args?: S
  /** One line for help. */
  summary?: string
  timeoutMs?: number | TimeoutFn<S>
  /** Output formatter id used by the CLI; unknown ids fall back to the generic one. */
  format?: string
  /** `session` methods only. Defaults to `auto`. Every session method takes
   *  the reserved `panelId` argument (CLI `--panel`) naming its target; the
   *  router resolves and strips it before the session sees the arguments. */
  target?: TargetPolicy
  /** Accept argument keys the shape does not declare and pass them through
   *  (option bags of page operations). */
  extraArgs?: boolean
  cli?: CateApiCliSpec<S>
}

export interface CateApiNamespaceOptions {
  /** The permission area. Without one only the master switch applies. */
  area?: CliPermissionArea
  /** Panel type a `session` method targets. Defaults to the namespace. */
  panelType?: string
  /** One line describing the command group in `cate --help`. */
  summary?: string
}

export interface CateApiMethod<S extends ArgShape = ArgShape> extends CateApiMethodSpec<S> {
  /** Name inside the namespace (`note.add`). */
  name: string
  /** Full wire name (`cate.review.note.add`). */
  method: string
  namespace: string
  area?: CliPermissionArea
  /** Target panel type for `session` methods. */
  panelType?: string
  args: S
}

export type CateApiMethods = Record<string, CateApiMethodSpec<any>>

export interface CateApiNamespace<M extends CateApiMethods = CateApiMethods> {
  namespace: string
  area?: CliPermissionArea
  summary?: string
  methods: { [K in keyof M & string]: CateApiMethod<NonNullable<M[K]['args']>> }
}

/** Full wire name of a method. The empty namespace holds top-level methods
 *  (`cate.version`). */
export function cateMethodName(namespace: string, name: string): string {
  return namespace ? `cate.${namespace}.${name}` : `cate.${name}`
}

const NAME = /^[a-z][A-Za-z0-9]*$/

export function defineCateApi<const M extends CateApiMethods>(
  namespace: string,
  methods: M,
  options: CateApiNamespaceOptions = {},
): CateApiNamespace<M> {
  if (namespace && !NAME.test(namespace)) throw new Error(`bad cate API namespace: ${namespace}`)
  const out: Record<string, CateApiMethod> = {}
  for (const [name, spec] of Object.entries(methods)) {
    if (!name.split('.').every((part) => NAME.test(part))) throw new Error(`bad cate API method name: ${name}`)
    if (spec.target && spec.handler !== 'session') {
      throw new Error(`cate.${namespace}.${name}: target applies to session methods only`)
    }
    const args = spec.args ?? {}
    if (spec.handler === 'session' && TARGET_ARG in args) {
      throw new Error(`cate.${namespace}.${name}: ${TARGET_ARG} is reserved for the target of session methods`)
    }
    let rest = 0
    for (const [key, schema] of Object.entries(args) as [string, AnyArgSchema][]) {
      if (schema.cli.rest) rest += 1
      if (schema.cli.rest && schema.cli.positional) {
        throw new Error(`cate.${namespace}.${name}: ${key} is both positional and rest`)
      }
    }
    if (rest > 1) throw new Error(`cate.${namespace}.${name}: at most one rest argument`)
    out[name] = {
      ...spec,
      name,
      method: cateMethodName(namespace, name),
      namespace,
      area: options.area,
      panelType: spec.handler === 'session' ? options.panelType ?? namespace : undefined,
      args,
    }
  }
  return {
    namespace,
    area: options.area,
    summary: options.summary,
    methods: out as CateApiNamespace<M>['methods'],
  }
}

/** Validates call arguments and applies defaults. Throws ArgError. The target
 *  argument of a session method is not part of its shape; take it off first. */
export function validateCateArgs(method: CateApiMethod, args: unknown): Record<string, unknown> {
  return validateShape(method.args, args, { extra: method.extraArgs === true })
}

export function cateApiTimeoutMs(method: CateApiMethod, args: Record<string, unknown>): number {
  const value = method.timeoutMs
  if (typeof value === 'function') return value(args as never)
  return value ?? DEFAULT_API_TIMEOUT_MS
}

/** Indexes namespaces by full method name. Throws on a duplicate. */
export function indexCateApi(namespaces: readonly CateApiNamespace[]): Map<string, CateApiMethod> {
  const index = new Map<string, CateApiMethod>()
  for (const ns of namespaces) {
    for (const method of Object.values(ns.methods) as CateApiMethod[]) {
      if (index.has(method.method)) throw new Error(`duplicate cate API method: ${method.method}`)
      index.set(method.method, method)
    }
  }
  return index
}

// ---- Handler contexts ------------------------------------------------------

/** Who is calling. CLI and harness callers are gated by the `cli*` settings;
 *  clients are not (D3). */
export interface ApiCaller {
  kind: 'cli' | 'harness' | 'client'
  /** Stable key for per-caller state (sticky target, code sessions). */
  id: string
  /** The panel the caller runs in: the terminal of a CLI token, the chat panel
   *  of a harness token. */
  panelId?: string
  /** New panels a caller creates are grouped with this id and implicit targets
   *  prefer panels in it. */
  placementGroupId?: string
  /** Client callers only. */
  clientId?: string
}

export function isGatedCaller(caller: ApiCaller): boolean {
  return caller.kind !== 'client'
}

export interface ApiStickyTarget {
  get(): string | undefined
  set(panelId: string): void
  clear(): void
}

export interface ApiHandlerContext {
  caller: ApiCaller
  /** Full wire name of the method being handled. */
  method: string
  /** Aborted when the call times out or is cancelled. */
  signal: AbortSignal
  /** The caller's sticky target (`cate panel set`). */
  sticky: ApiStickyTarget
  /** The panel implicit targeting would pick for `type`, without failing. */
  defaultTarget(type: string): string | undefined
  /** Calls another method as the same caller, through the same gates. Browser
   *  code cells use it for page operations. */
  invoke(method: string, args?: Record<string, unknown>): Promise<unknown>
}

export interface ApiSessionContext extends ApiHandlerContext {
  /** The resolved target panel. */
  panelId: string
}

type MethodsOf<N> = N extends CateApiNamespace<infer M> ? M : never

type HandlerArgs<Spec> = Spec extends { args: infer S extends ArgShape } ? OutArgs<S> : Record<string, never>

/** Handlers a module registers for the `service` methods of a namespace. */
export type CateServiceHandlers<N extends CateApiNamespace<any>> = {
  [K in keyof MethodsOf<N> as MethodsOf<N>[K]['handler'] extends 'service' ? K : never]:
    (args: HandlerArgs<MethodsOf<N>[K]>, ctx: ApiHandlerContext) => unknown | Promise<unknown>
}

/** Handlers a panel session provides for the `session` methods of a namespace. */
export type CateSessionHandlers<N extends CateApiNamespace<any>> = {
  [K in keyof MethodsOf<N> as MethodsOf<N>[K]['handler'] extends 'session' ? K : never]:
    (args: HandlerArgs<MethodsOf<N>[K]>, ctx: ApiSessionContext) => unknown | Promise<unknown>
}

/** What the router calls on a panel session. */
export type SessionApiHandler = (method: string, args: Record<string, unknown>, ctx: ApiSessionContext) => Promise<unknown>

/**
 * Builds a session's `handleApi` from typed handlers. The router has already
 * validated the arguments and passes the method name inside the namespace.
 */
export function sessionApi<N extends CateApiNamespace<any>>(
  _namespace: N,
  handlers: CateSessionHandlers<N>,
): SessionApiHandler {
  const table = handlers as Record<string, (args: unknown, ctx: ApiSessionContext) => unknown>
  return async (method, args, ctx) => {
    const handler = table[method]
    if (!handler) throw new RpcError('unsupported', `${ctx.method} is not handled by this panel`)
    return handler(args, ctx)
  }
}
