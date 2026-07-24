import { formatLocator, parseLocator } from './runtime/locator'
import type { FileAccessContext, Runtime } from './runtime/types'

interface WorktreeLocation {
  locator: string
  path: string
}

export interface WorktreeContext {
  runtimeId: string
  base: WorktreeLocation
  checkout: WorktreeLocation
}

/** Resolve a workspace's canonical checkout and active checkout on one runtime. */
export function resolveWorktreeContext(
  baseLocator: string,
  checkoutLocator: string,
): WorktreeContext | undefined {
  const base = parseLocator(baseLocator)
  const checkout = parseLocator(checkoutLocator)
  if (!base.path || !checkout.path || base.runtimeId !== checkout.runtimeId) return undefined

  return {
    runtimeId: base.runtimeId,
    base: { locator: formatLocator(base), path: base.path },
    checkout: { locator: formatLocator(checkout), path: checkout.path },
  }
}

/** Validate both sides of a worktree context against the same workspace scope. */
export async function validateWorktreeContext(
  context: WorktreeContext,
  runtime: Pick<Runtime, 'validatePathStrict'>,
  ownerWindowId: number | undefined,
  scopeId: string,
): Promise<WorktreeContext> {
  const [basePath, checkoutPath] = await Promise.all([
    runtime.validatePathStrict(context.base.path, ownerWindowId, scopeId),
    runtime.validatePathStrict(context.checkout.path, ownerWindowId, scopeId),
  ])

  return {
    runtimeId: context.runtimeId,
    base: {
      locator: formatLocator({ runtimeId: context.runtimeId, path: basePath }),
      path: basePath,
    },
    checkout: {
      locator: formatLocator({ runtimeId: context.runtimeId, path: checkoutPath }),
      path: checkoutPath,
    },
  }
}

/** List every non-bare checkout as a locator on the canonical checkout's runtime. */
export async function listWorktreeCheckouts(
  baseLocator: string,
  runtime: Pick<Runtime, 'vcs'>,
  access: FileAccessContext,
): Promise<string[]> {
  const base = parseLocator(baseLocator)
  if (!base.path) return []
  const worktrees = await runtime.vcs.worktreeList(base.path, access)
  return worktrees
    .filter((worktree) => !worktree.isBare)
    .map((worktree) => formatLocator({ runtimeId: base.runtimeId, path: worktree.path }))
}
