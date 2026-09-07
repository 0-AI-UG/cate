import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeJsonExclusive } from './atomicFile'

let directory: string
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-atomic-record-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', platform)
  await fs.rm(directory, { recursive: true, force: true })
})

it('publishes a restrictive complete record once and cleans all competing temporary files', async () => {
  const file = path.join(directory, 'record.json')
  await Promise.all(Array.from({ length: 8 }, (_, index) => writeJsonExclusive(file, { index })))
  expect(JSON.parse(await fs.readFile(file, 'utf8')).index).toBeGreaterThanOrEqual(0)
  expect(await fs.readdir(directory)).toEqual(['record.json'])
  if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
})

it('retries transient Windows publication failures', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('Scanner has the file open'), { code: 'EBUSY' }))
  const file = path.join(directory, 'record.json')
  await writeJsonExclusive(file, { captured: true })
  expect(link).toHaveBeenCalledTimes(2)
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ captured: true })
  expect(await fs.readdir(directory)).toEqual(['record.json'])
})

it('cleans up the temporary file when publication fails permanently', async () => {
  vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('Device error'), { code: 'EIO' }))
  await expect(writeJsonExclusive(path.join(directory, 'record.json'), { captured: true })).rejects.toThrow('Device error')
  expect(await fs.readdir(directory)).toEqual([])
})
