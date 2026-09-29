#!/usr/bin/env node
/* global process, setTimeout */

const provider = process.env.CATE_E2E_PROVIDER_NAME || 'provider'

process.stdout.write(`Starting ${provider} sign-in\r\n`)
process.stdout.write('Enter device code CATE-1234 in your browser.\r\n')

const finish = () => {
  process.stdout.write('Authentication complete.\r\n')
  process.exit(0)
}

// Claude's login falls back to a pasted authorization code.
if (provider === 'Claude') {
  process.stdout.write('Paste code here if prompted > ')
  process.stdin.setEncoding('utf8')
  let input = ''
  process.stdin.on('data', (chunk) => {
    input += chunk
    if (!/[\r\n]/.test(input)) return
    if (input.trim() !== 'pasted-code#state') {
      process.stdout.write('Invalid code\r\n')
      process.exit(1)
    }
    finish()
  })
} else {
  setTimeout(finish, 900)
}
