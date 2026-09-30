// Argument schemas for `cate` API methods. One declaration drives validation in
// the router and parsing, help and usage in the CLI.

export type ArgKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object'
  | 'record'
  | 'panel'
  | 'path'
  | 'custom'

/** How the CLI fills an argument. Without `positional`/`rest`, an argument is
 *  a `--flag` named after its key in kebab case. */
export interface CliArgMeta {
  /** Takes the next positional word. */
  positional?: boolean
  /** Takes every remaining positional word: joined with spaces for a string,
   *  one item each for an array. */
  rest?: boolean
  /** The flag name (without `--`). A positional argument with a flag may be
   *  given either way. */
  flag?: string
  /** Shown in help, after the argument. */
  help?: string
  /** Placeholder shown in usage (`<name>`). */
  valueName?: string
  /** Not settable from the command line. */
  hidden?: boolean
  /** Converts the raw word before validation. Throw to report a usage error. */
  parse?: (raw: string) => unknown
}

export interface NumberConstraints {
  min?: number
  max?: number
  integer?: boolean
}

export class ArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgError'
  }
}

interface SchemaDef {
  kind: ArgKind
  optional: boolean
  hasDefault: boolean
  defaultValue?: unknown
  cli: CliArgMeta
  values?: readonly string[]
  item?: ArgSchema<unknown, unknown>
  fields?: Record<string, ArgSchema<unknown, unknown>>
  panelType?: string
  number?: NumberConstraints
  maxLength?: number
  nonEmpty?: boolean
  check?: (value: unknown) => boolean
  description?: string
}

/**
 * An immutable argument schema. `Out` is what a handler receives after
 * validation (defaults applied); `In` is what a caller may send.
 */
export class ArgSchema<Out, In = Out> {
  declare readonly __out: Out
  declare readonly __in: In

  constructor(readonly def: SchemaDef) {}

  get kind(): ArgKind { return this.def.kind }
  get optional(): boolean { return this.def.optional }
  get cli(): CliArgMeta { return this.def.cli }

  private with(patch: Partial<SchemaDef>): this {
    return new ArgSchema({ ...this.def, ...patch }) as this
  }

  private withCli(patch: CliArgMeta): this {
    return this.with({ cli: { ...this.def.cli, ...patch } })
  }

  /** CLI: take the next positional word. */
  pos(valueName?: string): this {
    return this.withCli({ positional: true, ...(valueName ? { valueName } : {}) })
  }

  /** CLI: take every remaining positional word. */
  rest(valueName?: string): this {
    return this.withCli({ rest: true, ...(valueName ? { valueName } : {}) })
  }

  /** CLI: the flag name (without `--`). */
  flag(name: string, valueName?: string): this {
    return this.withCli({ flag: name, ...(valueName ? { valueName } : {}) })
  }

  help(text: string): this {
    return this.withCli({ help: text })
  }

  /** CLI: not settable from the command line. */
  hidden(): this {
    return this.withCli({ hidden: true })
  }

  /** CLI: convert the raw word before validation. */
  parseCli(parse: (raw: string) => unknown): this {
    return this.withCli({ parse })
  }

  min(value: number): this {
    return this.with({ number: { ...this.def.number, min: value } })
  }

  max(value: number): this {
    return this.with({ number: { ...this.def.number, max: value } })
  }

  int(): this {
    return this.with({ number: { ...this.def.number, integer: true } })
  }

  /** Strings: reject the empty (or all-whitespace) string. */
  nonEmpty(): this {
    return this.with({ nonEmpty: true })
  }

  maxLength(value: number): this {
    return this.with({ maxLength: value })
  }

  /** Validates `value` and returns it with defaults applied. */
  validate(value: unknown, name: string): Out {
    return validateValue(this.def, value, name) as Out
  }

  /** Short type label for help and errors (`<n>`, `old|new`). */
  describe(): string {
    return describeDef(this.def)
  }
}

export type AnyArgSchema = ArgSchema<any, any>
export type ArgShape = Record<string, AnyArgSchema>

function base(kind: ArgKind, extra: Partial<SchemaDef> = {}): SchemaDef {
  return { kind, optional: false, hasDefault: false, cli: {}, ...extra }
}

export const str: ArgSchema<string> = new ArgSchema(base('string'))
export const num: ArgSchema<number> = new ArgSchema(base('number'))
export const bool: ArgSchema<boolean> = new ArgSchema(base('boolean'))

/** An absolute path on the runtime's machine. The CLI resolves a relative
 *  path against its working directory before sending. */
export const path: ArgSchema<string> = new ArgSchema(base('path'))

/** One of a closed set of strings. */
export function oneOf<const V extends readonly string[]>(...values: V): ArgSchema<V[number]> {
  return new ArgSchema(base('enum', { values }))
}

/** A panel id. The router resolves a unique prefix to the full id and checks
 *  the panel's type when one is given. */
export function panel(type?: string): ArgSchema<string> {
  return new ArgSchema(base('panel', type ? { panelType: type } : {}))
}

export function arr<O, I>(item: ArgSchema<O, I>): ArgSchema<O[], I[]> {
  return new ArgSchema(base('array', { item: item as ArgSchema<unknown, unknown> }))
}

export type ObjOut<S extends ArgShape> = OutArgs<S>
export type ObjIn<S extends ArgShape> = InArgs<S>

/** A nested object with named fields. */
export function obj<S extends ArgShape>(fields: S): ArgSchema<ObjOut<S>, ObjIn<S>> {
  return new ArgSchema(base('object', { fields }))
}

/** A string-keyed map of one value type. */
export function record<O, I>(item: ArgSchema<O, I>): ArgSchema<Record<string, O>, Record<string, I>> {
  return new ArgSchema(base('record', { item: item as ArgSchema<unknown, unknown> }))
}

/** A value checked by a predicate, for shapes the helpers above do not cover. */
export function custom<T>(description: string, check: (value: unknown) => value is T): ArgSchema<T> {
  return new ArgSchema(base('custom', { check, description }))
}

/** Optional argument. With a default, handlers always receive a value. */
export function opt<O, I>(schema: ArgSchema<O, I>): ArgSchema<O | undefined, I | undefined>
export function opt<O, I>(schema: ArgSchema<O, I>, defaultValue: O): ArgSchema<O, I | undefined>
export function opt<O, I>(schema: ArgSchema<O, I>, ...rest: [] | [O]): ArgSchema<unknown, unknown> {
  return new ArgSchema({
    ...schema.def,
    optional: true,
    hasDefault: rest.length > 0,
    defaultValue: rest[0],
  })
}

// ---- Arg object types ------------------------------------------------------

type OptionalKeys<S extends ArgShape> = {
  [K in keyof S]: undefined extends S[K]['__in'] ? K : never
}[keyof S]

type RequiredKeys<S extends ArgShape> = Exclude<keyof S, OptionalKeys<S>>

type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** What a caller sends. */
export type InArgs<S extends ArgShape> = Simplify<
  { [K in RequiredKeys<S>]: S[K]['__in'] } & { [K in OptionalKeys<S>]?: S[K]['__in'] }
>

/** What a handler receives after validation. */
export type OutArgs<S extends ArgShape> = Simplify<
  { [K in keyof S as undefined extends S[K]['__out'] ? never : K]: S[K]['__out'] } &
  { [K in keyof S as undefined extends S[K]['__out'] ? K : never]?: S[K]['__out'] }
>

// ---- Validation ------------------------------------------------------------

function fail(name: string, expected: string): never {
  throw new ArgError(`invalid ${name}: expected ${expected}`)
}

function validateValue(def: SchemaDef, value: unknown, name: string): unknown {
  if (value === undefined || value === null) {
    if (def.hasDefault) return def.defaultValue
    if (def.optional) return undefined
    throw new ArgError(`missing ${name}`)
  }
  switch (def.kind) {
    case 'string':
    case 'path':
    case 'panel': {
      if (typeof value !== 'string') fail(name, 'a string')
      if ((def.nonEmpty || def.kind !== 'string') && value.trim() === '') fail(name, 'a non-empty string')
      if (def.maxLength !== undefined && value.length > def.maxLength) {
        fail(name, `at most ${def.maxLength} characters`)
      }
      return value
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(name, 'a number')
      const c = def.number ?? {}
      if (c.integer && !Number.isInteger(value)) fail(name, 'an integer')
      if (c.min !== undefined && value < c.min) fail(name, `a number >= ${c.min}`)
      if (c.max !== undefined && value > c.max) fail(name, `a number <= ${c.max}`)
      return value
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail(name, 'true or false')
      return value
    case 'enum':
      if (typeof value !== 'string' || !def.values!.includes(value)) fail(name, def.values!.join('|'))
      return value
    case 'array':
      if (!Array.isArray(value)) fail(name, 'an array')
      return value.map((item, index) => def.item!.validate(item, `${name}[${index}]`))
    case 'record': {
      if (typeof value !== 'object' || Array.isArray(value)) fail(name, 'an object')
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = def.item!.validate(item, `${name}.${key}`)
      }
      return out
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) fail(name, 'an object')
      return validateShape(def.fields!, value as Record<string, unknown>, { prefix: `${name}.`, extra: false })
    }
    case 'custom':
      if (!def.check!(value)) fail(name, def.description ?? 'a valid value')
      return value
  }
}

/** Validates a named argument object against a shape. Unknown keys are
 *  rejected unless `extra` is set, in which case they pass through unchanged. */
export function validateShape(
  shape: ArgShape,
  value: unknown,
  options: { prefix?: string; extra?: boolean } = {},
): Record<string, unknown> {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new ArgError('invalid arguments: expected an object')
  }
  const input = (value ?? {}) as Record<string, unknown>
  const prefix = options.prefix ?? ''
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(input)) {
    if (!(key in shape)) {
      if (!options.extra) throw new ArgError(`unknown argument ${prefix}${key}`)
      out[key] = input[key]
    }
  }
  for (const [key, schema] of Object.entries(shape)) {
    const validated = schema.validate(input[key], `${prefix}${key}`)
    if (validated !== undefined) out[key] = validated
  }
  return out
}

function describeDef(def: SchemaDef): string {
  switch (def.kind) {
    case 'number': return def.number?.integer ? 'integer' : 'number'
    case 'boolean': return 'bool'
    case 'enum': return def.values!.join('|')
    case 'array': return `${describeDef(def.item!.def)}...`
    case 'panel': return def.panelType ? `${def.panelType}-panel-id` : 'panel-id'
    case 'custom': return def.description ?? 'value'
    default: return def.kind
  }
}
