#!/usr/bin/env node
/* global process, setTimeout */

const provider = process.env.CATE_E2E_PROVIDER_NAME || 'provider'

process.stdout.write(`Starting ${provider} sign-in\r\n`)
process.stdout.write('Enter device code CATE-1234 in your browser.\r\n')
setTimeout(() => {
  process.stdout.write('Authentication complete.\r\n')
  process.exit(0)
}, 900)
