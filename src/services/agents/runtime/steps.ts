// The step a reported tool call shows as in its agent's chat: the files it
// edited, read with the change capture's own parser (`filesFromTool`), name
// it; otherwise what its input says it worked on (`agentStep`), a path in
// the checkout relative to it.

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { agentStep, type AgentStep, type AgentToolCall } from '../contract'
import { filesFromTool } from './changes/edits'

const canonical = (dir: string): string => {
  try { return realpathSync.native(dir) } catch { return dir }
}

/** `subject` relative to `cwd` when it is a path inside it. */
function inCheckout(cwd: string, subject: string): string {
  if (!path.isAbsolute(subject)) return subject
  const relative = path.relative(cwd, path.join(canonical(path.dirname(subject)), path.basename(subject)))
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.replace(/\\/g, '/') : subject
}

export function agentStepOf(call: AgentToolCall, cwd: string | null, at = new Date().toISOString()): AgentStep {
  if (!cwd) return agentStep(call, at)
  const checkout = canonical(cwd)
  const files = filesFromTool(checkout, call.name, call.input, call.output, call.cwd ?? checkout).map((file) => file.path)
  const step = agentStep(call, at, files)
  return step.subject ? { ...step, subject: inCheckout(checkout, step.subject) } : step
}
