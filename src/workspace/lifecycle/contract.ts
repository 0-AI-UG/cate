// workspace/lifecycle contract: trust and the `workspace` capability
// (architecture 9.2). Pure.

export * from './contract/capability'

/** What every module that runs processes or applies `.cate/` takes. */
export interface Trust {
  isTrusted(): boolean
  /** Throws `RpcError('untrusted')` until the workspace is trusted. */
  requireTrusted(): void
}

