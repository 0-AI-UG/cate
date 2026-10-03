import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileSink } from './fileSink'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-log-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const record = (level: 'debug' | 'info', message: string) => ({ level, scope: 's', message, args: [], time: 0 })

it('appends lines at or above the level and rotates past the size limit', () => {
  const file = path.join(dir, 'logs', 'daemon.log')
  const sink = createFileSink({ file, maxBytes: 200 })
  sink(record('debug', 'dropped'))
  sink(record('info', 'first'))
  expect(fs.readFileSync(file, 'utf-8')).toMatch(/\[info\] \[s\] first\n$/)
  for (let i = 0; i < 5; i++) sink(record('info', `line ${i} ${'x'.repeat(20)}`))
  expect(fs.existsSync(path.join(dir, 'logs', 'daemon.old.log'))).toBe(true)
  expect(fs.statSync(file).size).toBeLessThanOrEqual(200)
  expect(fs.readFileSync(file, 'utf-8')).not.toContain('dropped')
})
