// One-shot helpers for small self-contained files (install id, analytics
// state, jsonl buffers) that do not need a live in-memory authority.

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../../log/contract'
import { writeFileAtomicSync, writeJsonAtomicSync, type WriteJsonOptions } from './atomicFile'
import { quarantineCorruptFile } from './quarantine'

const log = createLogger('state')

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Parse a JSON object file. Returns `fallback` on any failure; an unparseable
 *  file is quarantined first. */
export function readJsonFile<T>(file: string, fallback: T): T {
  let raw: string
  try {
    if (!fs.existsSync(file)) return fallback
    raw = fs.readFileSync(file, 'utf-8')
  } catch (error) {
    log.warn('read %s failed: %s', file, message(error))
    return fallback
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    const backup = quarantineCorruptFile(file)
    log.warn('%s is corrupt%s; using fallback', file, backup ? `, backed up to ${backup}` : '')
    return fallback
  }
}

/** Atomically write a JSON file. Logs instead of throwing. */
export function writeJsonFile(file: string, value: unknown, options: WriteJsonOptions = {}): void {
  try {
    writeJsonAtomicSync(file, value, options)
  } catch (error) {
    log.warn('write %s failed: %s', file, message(error))
  }
}

export function readTextFile(file: string): string | null {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null
  } catch (error) {
    log.warn('read %s failed: %s', file, message(error))
    return null
  }
}

export function writeTextFile(file: string, text: string): void {
  try {
    writeFileAtomicSync(file, text)
  } catch (error) {
    log.warn('write %s failed: %s', file, message(error))
  }
}

/** Append one newline-terminated line (jsonl buffers). */
export function appendLine(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n', 'utf-8')
  } catch (error) {
    log.warn('append %s failed: %s', file, message(error))
  }
}

export function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch (error) {
    log.warn('remove %s failed: %s', file, message(error))
  }
}
