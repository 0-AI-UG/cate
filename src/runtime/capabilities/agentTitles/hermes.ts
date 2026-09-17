import type { AgentTitleResolver } from './types'

/** Hermes does not currently expose a stable public title lookup contract. */
export const resolveHermesTitle: AgentTitleResolver = async () => null
