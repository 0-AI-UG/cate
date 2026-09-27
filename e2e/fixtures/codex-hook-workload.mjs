// Synthetic Codex traffic through the real PTY, authenticated HTTP hook
// ingestion, agent-presence scan, IPC, and renderer status/animation paths.
// The E2E test runs a copy of Node named "codex" so the normal process matcher
// recognizes the fixture. No model requests or user projects are involved.
/* global process, fetch, console */
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

const session = randomUUID()
const deadline = Date.now() + Number(process.argv[2])
let turn = 0
async function post(name, extra = {}) {
  const response = await fetch(`${process.env.CATE_HOOK_ENDPOINT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CATE_HOOK_TOKEN}` },
    body: JSON.stringify({
      agentId: 'codex', terminalId: process.env.CATE_TERMINAL_ID, pid: process.pid,
      payload: { hook_event_name: name, session_id: session, turn_id: `turn-${turn}`, cwd: process.cwd(), ...extra },
    }),
  })
  if (!response.ok) throw new Error(`Hook HTTP ${response.status}`)
  await response.text()
}

async function main() {
  await post('SessionStart')
  while (Date.now() < deadline) {
    turn++
    await post('UserPromptSubmit')
    process.stdout.write(`\r\nsoak-tick-${turn}: Working on a synthetic edit\r\n`)
    await delay(150)
    await post('PermissionRequest', { tool_name: 'apply_patch' })
    await delay(100)
    await post('PreToolUse', { tool_name: 'apply_patch' })
    await delay(150)
    await post('PostToolUse', {
      tool_name: 'apply_patch', tool_use_id: `tool-${turn}`,
      tool_input: `*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before ${turn}\n+after ${turn}\n*** End Patch`,
      tool_response: { success: true },
    })
    await delay(150)
    await post(turn % 5 ? 'Stop' : 'Interrupt')
    await delay(150)
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
