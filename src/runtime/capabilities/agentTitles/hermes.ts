import type { AgentTitleResolver } from './types'

// Hermes stores generated titles asynchronously and exposes no title-change
// hook. Keep the panel's stable "Hermes" label until a supported API exists.
export const resolveHermesTitle: AgentTitleResolver = async () => null
