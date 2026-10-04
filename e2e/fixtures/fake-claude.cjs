/* global process, require, console */
/* eslint-disable @typescript-eslint/no-require-imports */
// Claude Code stand-in for a real Cate terminal. Started through a symlink
// named `claude` (so Cate sees a claude process), it runs the hook commands
// in <cwd>/.claude/settings.local.json the way the CLI does: hook JSON on
// stdin, a UserPromptSubmit hook's stdout read for additionalContext. Each
// prompt line is appended to the file in argv[2] as {prompt, context}.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const out = process.argv[2]
let hooks = {}
try {
  hooks = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.claude', 'settings.local.json'), 'utf8')).hooks ?? {}
} catch { /* no hook file: Cate's hooks are not installed */ }

const run = (event, extra = {}) => {
  const commands = (hooks[event] ?? []).flatMap((group) => group.hooks ?? []).map((hook) => hook.command).filter((command) => typeof command === 'string')
  let stdout = ''
  for (const command of commands) {
    const input = JSON.stringify({ hook_event_name: event, session_id: 'fake-session', cwd: process.cwd(), ...extra })
    stdout += spawnSync(command, { shell: true, input, encoding: 'utf8' }).stdout ?? ''
  }
  return stdout
}

run('SessionStart')
console.log(`FAKE_CLAUDE_READY hooks=${Object.keys(hooks).length > 0}`)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.search(/[\r\n]/); end >= 0; end = buffer.search(/[\r\n]/)) {
    const prompt = buffer.slice(0, end).replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '').trim()
    buffer = buffer.slice(end + 1)
    if (!prompt) continue
    let context = null
    try { context = JSON.parse(run('UserPromptSubmit', { prompt })).hookSpecificOutput?.additionalContext ?? null } catch { /* no context */ }
    fs.appendFileSync(out, JSON.stringify({ prompt, context }) + '\n')
    run('Stop')
    console.log('FAKE_CLAUDE_TURN_DONE')
  }
})
