// Deterministic CLI stand-in. Runs inside Cate's real PTY, using only the
// source-bound hook credentials inherited by agent child processes.
const fs = require('node:fs')
const [agentId, session, file] = process.argv.slice(2)
const input = { file_path: file, old_string: 'before', new_string: `after-${agentId}` }
const payload = agentId === 'opencode'
  ? { type: 'message.part.updated', sessionID: session, part: { type: 'tool', tool: 'edit', callID: 'edit', state: { status: 'completed', input } } }
  : agentId === 'grok'
    ? { hookEventName: 'post_tool_use', sessionId: session, toolName: 'replace_file_content', toolInput: input, toolUseId: 'edit' }
    : { hook_event_name: agentId === 'cursor' ? 'postToolUse' : 'PostToolUse', session_id: session, tool_name: agentId === 'kiro' ? 'fs_write' : 'Edit', tool_input: input, tool_use_id: 'edit' }
async function main() {
  fs.writeFileSync(file, `after-${agentId}\n`)
  const post = (payload) => fetch(process.env.CATE_HOOK_ENDPOINT + '/hook', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CATE_HOOK_TOKEN}` },
    body: JSON.stringify({ terminalId: process.env.CATE_TERMINAL_ID, agentId, payload }),
  })
  for (let retry = 0; retry < 2; retry++) {
    const response = await post(payload)
    if (response.status !== 204) throw new Error(`Hook failed: ${response.status}`)
  }
  const failed = await post({ ...payload, success: false, tool_use_id: 'failed', toolUseId: 'failed' })
  if (failed.status !== 204) throw new Error(`Failed-event delivery: ${failed.status}`)
  console.log('CAPTURE_FIXTURE_DONE')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
