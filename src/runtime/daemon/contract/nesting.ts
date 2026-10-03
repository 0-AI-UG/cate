// Why a workspace's runtime refuses every client: its folder overlaps one that
// is already open (workspaces never nest). Travels as the hello refusal's
// `data`, so a client can offer the open workspace instead.

export interface NestedRefusal {
  nested: {
    /** The root of the open workspace it overlaps. */
    root: string
  }
}

/** The overlapping root of a refusal, or null when it is another refusal. */
export function nestedRefusalRoot(data: unknown): string | null {
  const nested = (data as Partial<NestedRefusal> | null | undefined)?.nested
  return typeof nested?.root === 'string' ? nested.root : null
}
