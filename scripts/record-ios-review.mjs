#!/usr/bin/env node
// Drive the installed iOS app through Appium; no application code or fixtures.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  'session-file': { type: 'string' },
  'pairing-code-file': { type: 'string' },
  server: { type: 'string', default: 'http://127.0.0.1:4723' },
  plan: { type: 'string' },
  output: { type: 'string', default: '/private/tmp/cate-review-recordings' },
  inspect: { type: 'boolean' },
  tap: { type: 'string' },
  record: { type: 'boolean', default: false },
  help: { type: 'boolean' },
} })
if (values.help || !values['session-file']) {
  console.log(`Usage: node scripts/record-ios-review.mjs --session-file PATH [options]
  --inspect            Print visible, accessible Cate controls
  --tap LABEL          Tap one visible control (for rehearsing)
  --plan PATH          Run a JSON array of timed UI steps
  --pairing-code-file PATH  Read a fresh code privately for the pairing plan
  --record             Record the plan; omitted means rehearsal
  --output DIR         Local video and chapter timings
  --server URL         Appium endpoint (default: localhost:4723)

The phone must stay unlocked and in Cate. Recordings are never uploaded.
If Cate leaves the foreground, the entire take is discarded.
Steps: {tap, type}, {wait}, {hold: seconds}, {keys: text},
       {pairingCode: true}, {tapPoint: [x,y]}, {chapter: text}.
Labels are exact accessibility names. Pairing codes are never logged.
Point taps must be grounded in a rehearsed screen on this same device.`)
  process.exit(values.help ? 0 : 1)
}

const bundleId = 'com.0ai.cate.ios'
const session = JSON.parse(await readFile(values['session-file'], 'utf8')).value.sessionId
if (!session) throw new Error('Session file does not contain a successful Appium session')
const base = `${values.server.replace(/\/$/, '')}/session/${session}`
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const result = await response.json()
  if (!response.ok || result.value?.error) throw new Error(result.value?.message ?? response.statusText)
  return result.value
}
const mobile = (command, args) => request('/execute/sync', { script: `mobile: ${command}`, args: [args] })
const delay = ms => new Promise(done => setTimeout(done, ms))
let interrupted = false
process.on('SIGINT', () => { interrupted = true })
process.on('SIGTERM', () => { interrupted = true })
async function guard() {
  if (interrupted) throw new Error('Interrupted; discarding this take')
  const app = await mobile('activeAppInfo', {})
  if (app.bundleId !== bundleId) throw new Error('Cate left the foreground; discarding this take')
}
// Read the native accessibility tree, excluding hidden web-core elements.
async function controls() {
  await guard()
  const xml = await request('/source')
  return [...xml.matchAll(/<XCUIElementType\w+\b[^>]*>/g)].map(([tag]) => {
    const attrs = Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v
      .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')]))
    return attrs
  }).filter(a => a.visible === 'true' && a.accessible === 'true')
}
function predicate(label) {
  return `(name == ${JSON.stringify(label)} OR label == ${JSON.stringify(label)}) AND accessible == true AND visible == true`
}
async function element(label) {
  const result = await request('/elements', { using: '-ios predicate string', value: predicate(label) })
  return result[0]?.['element-6066-11e4-a52e-4f735466cecf']
}
async function waitFor(label) {
  const deadline = Date.now() + 15_000
  do {
    await guard()
    const id = await element(label)
    if (id) return id
    await delay(250)
  } while (Date.now() < deadline)
  throw new Error(`Visible control not found: ${label}`)
}
async function tap(label) {
  const id = await waitFor(label)
  const rect = await request(`/element/${id}/rect`)
  await mobile('tap', { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
}
if (values.inspect) {
  for (const a of await controls()) console.log(JSON.stringify({ type: a.type, name: a.name, label: a.label, value: a.value, x: a.x, y: a.y, width: a.width, height: a.height }))
  process.exit(0)
}
if (values.tap) {
  await tap(values.tap)
  for (const a of await controls()) console.log(JSON.stringify(a))
  process.exit(0)
}
if (!values.plan) throw new Error('Specify --plan, --inspect, or --tap')
const steps = JSON.parse(await readFile(values.plan, 'utf8'))
if (!Array.isArray(steps)) throw new Error('Plan must be an array')
const initial = await controls()
const pairingCode = values['pairing-code-file'] ? (await readFile(values['pairing-code-file'], 'utf8')).trim() : undefined
if (pairingCode !== undefined) {
  if (!/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){8}$/.test(pairingCode)) throw new Error('Invalid pairing code format')
  if (!initial.some(a => a.name === 'Join a workspace')) throw new Error('Open the Join a workspace sheet before running the pairing plan')
} else if (!initial.some(a => a.name === 'cate-review-demo') || !initial.some(a => a.name === 'Canvas')) {
  throw new Error('Open the cate-review-demo workspace canvas before running a plan')
}
const output = resolve(values.output)
await mkdir(output, { recursive: true })
const take = new Date().toISOString().replaceAll(/[:.]/g, '-')
const chapters = []
let recording = false
let successful = false
let recordingStarted = 0
// Poll independently during waits and Appium actions, including long transitions.
let monitoring = false
let privacyFailure
const monitor = setInterval(async () => {
  if (monitoring) return
  monitoring = true
  try { await guard() } catch (error) { privacyFailure = error }
  finally { monitoring = false }
}, 500)
try {
  await guard()
  if (values.record) {
    await request('/appium/start_recording_screen', { options: { videoType: 'h264', videoQuality: 'high', videoFps: 30, timeLimit: '600' } })
    recording = true
  }
  recordingStarted = Date.now()
  for (const [index, step] of steps.entries()) {
    if (privacyFailure) throw privacyFailure
    await guard()
    console.log(`${index + 1}/${steps.length}: ${step.chapter ?? step.tap ?? step.wait ?? (step.hold ? 'viewing pause' : 'input')}`)
    if (step.chapter) chapters.push({ title: step.chapter, wallSeconds: (Date.now() - recordingStarted) / 1000 })
    if (step.tap) {
      await tap(step.tap)
      if (step.type !== undefined) await request('/keys', { value: [...step.type] })
    }
    if (step.keys !== undefined) await request('/keys', { value: [...step.keys] })
    if (step.pairingCode) {
      if (!pairingCode) throw new Error('Pairing step requires --pairing-code-file')
      const fields = await request('/elements', { using: 'class name', value: 'XCUIElementTypeTextField' })
      if (fields.length !== 1) throw new Error('Expected exactly one pairing code field')
      const id = fields[0]['element-6066-11e4-a52e-4f735466cecf']
      await request(`/element/${id}/value`, { text: pairingCode })
    }
    if (step.tapPoint) await mobile('tap', { x: step.tapPoint[0], y: step.tapPoint[1] })
    if (step.wait) await waitFor(step.wait)
    if (step.hold) {
      const until = Date.now() + step.hold * 1000
      while (Date.now() < until) {
        if (privacyFailure) throw privacyFailure
        await guard()
        await delay(Math.min(250, Math.max(0, until - Date.now())))
      }
    }
    await guard()
    if (privacyFailure) throw privacyFailure
  }
  successful = true
} finally {
  clearInterval(monitor)
  if (recording) {
    const encoded = await request('/appium/stop_recording_screen', { options: {} })
    await guard()
    // Never persist an interrupted or potentially private recording.
    if (successful && !privacyFailure && !interrupted) {
      if (!encoded) throw new Error('Appium returned an empty recording')
      const video = join(output, `${take}.mp4`)
      await writeFile(video, Buffer.from(encoded, 'base64'), { mode: 0o600 })
      await writeFile(join(output, `${take}.chapters.json`), JSON.stringify(chapters, null, 2))
      console.log(`Saved ${video}`)
    } else console.log('Take discarded; no video saved')
  }
}
