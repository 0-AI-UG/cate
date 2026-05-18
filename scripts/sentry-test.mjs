#!/usr/bin/env node
// =============================================================================
// Send a single test event to the Sentry-protocol endpoint configured via
// SENTRY_DSN (falls back to the Cate analytics endpoint). Used to verify the
// pipe end-to-end without launching the app.
//
// Usage: npm run sentry:test
//        SENTRY_DSN='https://any@host/1' npm run sentry:test
// =============================================================================

import { randomUUID } from 'node:crypto'

const DEFAULT_DSN = 'https://any@analytics.cero-ai.com/1'
const dsn = process.env.SENTRY_DSN || DEFAULT_DSN

const match = dsn.match(/^(https?):\/\/([^@]+)@([^/]+)\/(\d+)$/)
if (!match) {
  console.error(`Invalid SENTRY_DSN: ${dsn}`)
  console.error('Expected: https://<key>@<host>/<project_id>')
  process.exit(1)
}
const [, scheme, key, host, projectId] = match
const url = `${scheme}://${host}/api/${projectId}/envelope/?sentry_key=${key}&sentry_version=7`

const eventId = randomUUID().replace(/-/g, '')
const sentAt = new Date().toISOString()

const event = {
  event_id: eventId,
  timestamp: sentAt,
  platform: 'javascript',
  level: 'info',
  message: `Test event from sentry:test @ ${sentAt}`,
  release: 'cate@test',
  environment: 'test',
  tags: { source: 'sentry-test-script' },
  contexts: {
    runtime: { name: 'node', version: process.version },
    os: { name: process.platform, version: process.arch },
  },
}

const envelope = [
  JSON.stringify({ event_id: eventId, sent_at: sentAt, dsn }),
  JSON.stringify({ type: 'event' }),
  JSON.stringify(event),
].join('\n')

console.log(`POST ${url}`)
console.log(`event_id: ${eventId}`)

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'User-Agent': 'cate-sentry-test/1.0',
    },
    body: envelope,
  })
  const text = await res.text()
  console.log(`\nStatus: ${res.status} ${res.statusText}`)
  if (text) console.log(`Body: ${text}`)
  if (!res.ok) process.exit(1)
  console.log('\nOK — check your Sentry dashboard for the event.')
} catch (err) {
  console.error('\nRequest failed:', err.message)
  process.exit(1)
}
