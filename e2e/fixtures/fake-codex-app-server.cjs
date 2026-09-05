#!/usr/bin/env node
/* global process, require, setTimeout, setInterval, clearInterval */
/* eslint-disable @typescript-eslint/no-require-imports */
// Deterministic provider boundary for REAL T3 E2E. T3 owns all chat state,
// rendering, orchestration and persistence; this CLI only speaks Codex JSON-RPC.
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { createInterface } = require('node:readline')
const statePath = process.env.CATE_E2E_CODEX_STATE
if (!statePath) throw new Error('CATE_E2E_CODEX_STATE must point to isolated test storage')
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.153.2\n'); process.exit(0) }
if (process.argv.includes('login')) { process.stdout.write('Logged in using ChatGPT\n'); process.exit(0) }
if (process.argv.includes('exec')) {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { prompt += chunk })
  process.stdin.on('end', () => {
    const schema = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--output-schema') + 1], 'utf8'))
    if (!schema.properties?.title) throw new Error('Unsupported fixture text generation schema')
    fs.appendFileSync(statePath + '.requests', JSON.stringify({ method: 'fixture/title', prompt }) + '\n')
    if (prompt.includes('fixture:title-error')) {
      fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], 'invalid title JSON')
      return
    }
    const title = prompt.includes('The previous title was') ? 'Refined Conversation Title' : 'Generated Conversation Title'
    fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify({ title }))
  })
  return
}
if (!process.argv.includes('app-server')) { process.stderr.write('Unsupported fake Codex invocation\n'); process.exit(1) }
fs.appendFileSync(statePath + '.requests', JSON.stringify({ method: 'fixture/startup', args: process.argv.slice(2), home: process.env.CODEX_HOME, marker: process.env.CATE_E2E_MARKER, secret: process.env.CATE_E2E_SECRET }) + '\n')
const read = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
const save = (thread) => fs.writeFileSync(statePath, JSON.stringify({ ...read(), [thread.id]: thread }))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
function notify(method, params) {
  if (method === 'item/started') params.startedAtMs = Date.now()
  if (method === 'item/completed') params.completedAtMs = Date.now()
  send({ method, params })
}
let active
const pending = new Map()
function finish(thread, turn, text, status = 'completed') {
  if (turn.status !== 'inProgress') return
  const item = { type: 'agentMessage', id: randomUUID(), text, phase: 'final_answer' }
  notify('item/started', { threadId: thread.id, turnId: turn.id, item: { ...item, text: '' } })
  notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: text })
  turn.items.push(item)
  notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
  turn.status = status
  save(thread)
  notify('turn/completed', { threadId: thread.id, turn })
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  fs.appendFileSync(statePath + '.requests', JSON.stringify(message) + '\n')
  if (!message.method) {
    if (message.error) throw new Error(JSON.stringify(message.error))
    const approval = pending.get(message.id)
    if (approval) {
      pending.delete(message.id)
      finish(approval.thread, approval.turn, message.result?.decision === 'accept' ? 'Approved fixture command' : 'Declined fixture command')
    }
    return
  }
  const { id, method, params = {} } = message
  const reply = (result) => send({ id, result })
  if (method === 'initialized') return
  if (method === 'initialize') return reply({ codexHome: process.env.CODEX_HOME || process.cwd(), userAgent: 'cate-e2e', platformFamily: process.platform, platformOs: process.platform })
  if (method === 'account/read') return reply({ account: { type: 'apiKey' }, requiresOpenaiAuth: false })
  if (method === 'skills/list') return reply({ data: (params.cwds || []).map(cwd => ({ cwd, skills: [], errors: [] })) })
  if (method === 'model/list') return reply({ data: [{ id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'Fixture model', description: 'Deterministic E2E model', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }] }], nextCursor: null })
  if (method === 'thread/start' || method === 'thread/resume') {
    const thread = method === 'thread/resume' ? read()[params.threadId] : {
      id: randomUUID(), sessionId: randomUUID(), cliVersion: '0.153.2', cwd: params.cwd || process.cwd(),
      ephemeral: false, modelProvider: 'openai', preview: '', source: 'appServer', status: { type: 'idle' },
      createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), turns: [],
    }
    if (!thread) return send({ id, error: { code: -32602, message: 'Unknown fixture thread' } })
    save(thread)
    return reply({ thread, model: 'gpt-5.4', modelProvider: 'openai', cwd: thread.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, reasoningEffort: 'medium' })
  }
  if (method === 'thread/read') return reply({ thread: read()[params.threadId] })
  if (method === 'turn/start') {
    const thread = read()[params.threadId]
    const text = params.input.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
    const turn = { id: randomUUID(), status: 'inProgress', items: [], error: null }
    thread.turns.push(turn)
    save(thread)
    active = { thread, turn }
    reply({ turn })
    notify('turn/started', { threadId: thread.id, turn })
    if (text.includes('fixture:approval')) {
      const approvalId = randomUUID()
      pending.set(approvalId, { thread, turn })
      return send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, itemId: randomUUID(), command: 'echo fixture-approved', cwd: thread.cwd, reason: 'Fixture approval request', startedAtMs: Date.now() } })
    }
    if (text.includes('fixture:cancel')) return
    if (text.includes('fixture:crash')) return setTimeout(() => process.exit(17), 100)
    // A gated stream lets the test assert partial output before releasing the
    // final chunk. Ordinary replies finish automatically.
    const item = { type: 'agentMessage', id: randomUUID(), text: '', phase: 'final_answer' }
    notify('item/started', { threadId: thread.id, turnId: turn.id, item })
    notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: 'Fixture streaming' })
    const complete = () => {
      if (turn.status !== 'inProgress') return
      item.text = 'Fixture streaming reply: ' + text
      turn.items.push(item)
      notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: ' reply: ' + text })
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
      turn.status = 'completed'
      save(thread)
      notify('turn/completed', { threadId: thread.id, turn })
    }
    if (text.includes('fixture:stream')) {
      const timer = setInterval(() => {
        if (!fs.existsSync(statePath + '.release-stream')) return
        fs.unlinkSync(statePath + '.release-stream')
        clearInterval(timer)
        complete()
      }, 25)
    } else setTimeout(complete, 100)
    return
  }
  if (method === 'turn/interrupt') {
    reply({})
    if (active) finish(active.thread, active.turn, 'Fixture interrupted', 'interrupted')
    return
  }
  if (method === 'thread/name/set') return reply({})
  send({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } })
})
