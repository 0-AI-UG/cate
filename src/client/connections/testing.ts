import type { RuntimeUpdates } from './runtimeUpdate'

/** Runtime updates for tests that never meet a runtime of another version. */
export const noRuntimeUpdates: RuntimeUpdates = {
  required: () => null,
  run: () => null,
  subscribe: () => () => {},
  update: async () => null,
  dispose() {},
}
