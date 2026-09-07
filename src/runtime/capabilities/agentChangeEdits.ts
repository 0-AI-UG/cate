import path from 'node:path'
import { realpathSync } from 'node:fs'
import { createTwoFilesPatch } from 'diff'
import type { AgentChangedFile } from '../../shared/agentChanges'
import type { GitDiffHunk } from '../../shared/types'
import { parseReviewPatch } from './vcs'

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

function relativeFile(cwd: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.includes('\0')) return
  let resolved = value
  if (path.isAbsolute(resolved)) {
    try { resolved = path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved)) } catch { /* deleted parent */ }
  }
  const relative = path.isAbsolute(resolved) ? path.relative(cwd, resolved) : resolved
  const normalized = path.normalize(relative).replace(/\\/g, '/')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) return
  return normalized
}

function fileFromHunks(filePath: string, hunks: GitDiffHunk[], coverage: AgentChangedFile['coverage'], patch?: string): AgentChangedFile {
  const lines = hunks.flatMap((hunk) => hunk.lines)
  return { path: filePath, hunks, coverage, patch,
    additions: lines.filter((line) => line.kind === 'add').length,
    deletions: lines.filter((line) => line.kind === 'delete').length }
}

function fragmentLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // A terminating newline closes the last line; it does not add a blank line.
  // Remove exactly that sentinel so real leading/trailing blank lines survive.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Git quotes paths using C escapes, including octal UTF-8 bytes (not JSON). */
function unquoteGitPath(value: string): string {
  if (!value.startsWith('"')) return value
  if (!value.endsWith('"')) return ''
  const chunks: Buffer[] = []
  const escaped: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' }
  const body = value.slice(1, -1)
  for (let index = 0; index < body.length;) {
    if (body[index] !== '\\') {
      const next = body.indexOf('\\', index)
      const end = next < 0 ? body.length : next
      chunks.push(Buffer.from(body.slice(index, end)))
      index = end
      continue
    }
    const octal = body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0]
    if (octal) {
      chunks.push(Buffer.from([Number.parseInt(octal, 8)]))
      index += octal.length + 1
    } else {
      const character = escaped[body[index + 1]]
      if (character === undefined) return ''
      chunks.push(Buffer.from(character))
      index += 2
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function filesFromPatch(cwd: string, patch: string): AgentChangedFile[] {
  const sections = patch.split(/(?=^diff --git )/m).filter((section) => section.startsWith('diff --git '))
  return sections.flatMap((section) => {
    const header = section.match(/^diff --git (".*?"|a\/.*?) (".*?"|b\/.*?)$/m)
    const target = section.match(/^\+\+\+ (.+)$/m)?.[1]?.split('\t')[0]
    const source = section.match(/^--- (.+)$/m)?.[1]?.split('\t')[0]
    const rawPath = target && target !== '/dev/null' ? target : source && source !== '/dev/null' ? source : header?.[2]
    const filePath = relativeFile(cwd, unquoteGitPath(rawPath ?? '').replace(/^[ab]\//, ''))
    if (!filePath) return []
    const hunks = parseReviewPatch(section)
    const file = fileFromHunks(filePath, hunks, hunks.length ? 'patch' : 'unavailable', section)
    const oldPath = relativeFile(cwd, unquoteGitPath(source ?? header?.[1] ?? '').replace(/^a\//, ''))
    if (oldPath && oldPath !== filePath) file.oldPath = oldPath
    return [file]
  })
}

/** Inputs are accepted only after a successful tool completion. No filesystem
 * reads: a post-tool read could already contain another agent's writes. */
export function filesFromTool(cwd: string, toolName: string, inputValue: unknown, outputValue?: unknown, executionCwd = cwd): AgentChangedFile[] {
  const toolPath = (value: unknown) => relativeFile(cwd, typeof value === 'string' && value ? path.resolve(executionCwd, value) : value)
  if (typeof inputValue === 'string' && inputValue.trim().startsWith('{')) {
    try { inputValue = JSON.parse(inputValue) } catch { /* not JSON tool input */ }
  }
  const input = object(inputValue)
  const output = object(outputValue)
  // ACP providers (Cursor/Grok) report before/after content as typed diffs.
  const content = Array.isArray(output.content) ? output.content : Array.isArray(input.content) ? input.content : []
  const acpFiles = content.flatMap((value) => {
    const diff = object(value)
    if (diff.type !== 'diff' || typeof diff.newText !== 'string') return []
    const filePath = toolPath(diff.path)
    if (!filePath) return []
    const patch = createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, string(diff.oldText) ?? '', diff.newText, undefined, undefined, { timeout: 100 })
    return [fileFromHunks(filePath, patch ? parseReviewPatch(patch) : [], patch ? 'patch' : 'unavailable', patch)]
  })
  if (acpFiles.length) return acpFiles
  const patch = string(output.diff) ?? string(output.patch) ?? string(input.patch) ?? string(input.patchText)
    ?? (toolName === 'apply_patch' ? string(input.command) : undefined)
    ?? (typeof inputValue === 'string' && inputValue.includes('*** Begin Patch') ? inputValue : undefined)
  if (patch?.includes('diff --git ')) return filesFromPatch(cwd, patch)
  if (patch?.includes('*** Begin Patch')) {
    return patch.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m).flatMap((section) => {
      const name = section.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)?.[1]
      const oldPath = toolPath(name)
      const move = section.match(/^\*\*\* Move to: (.+)$/m)?.[1]
      const filePath = move === undefined ? oldPath : toolPath(move)
      if (!filePath || !oldPath) return []
      const lines = section.split('\n').filter((line) => /^[+ -]/.test(line) && !line.startsWith('***'))
      const hunks = lines.length ? parseReviewPatch(`@@ -1 +1 @@\n${lines.join('\n')}`) : []
      return [{ ...fileFromHunks(filePath, hunks, hunks.length ? 'fragment' : 'unavailable'), ...(move === undefined ? {} : { oldPath }) }]
    })
  }
  // Codex app-server fileChange items carry a path and unified diff per file.
  if (Array.isArray(input.changes)) return input.changes.flatMap((value) => {
    const change = object(value)
    const filePath = toolPath(change.path)
    if (!filePath) return []
    const diff = string(change.diff)
    return [fileFromHunks(filePath, diff ? parseReviewPatch(diff) : [], diff ? 'patch' : 'unavailable', diff)]
  })
  const filePath = toolPath(input.file_path ?? input.filePath ?? input.path ?? output.filePath)
  if (!filePath || !/edit|write|patch|replace|create|delete|remove|move|str_replace/i.test(toolName)) return []
  if (typeof input.content === 'string' && (output.type === 'create' || typeof output.originalFile === 'string')) {
    const patch = createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, string(output.originalFile) ?? '', input.content, undefined, undefined, { timeout: 100 })
    return [fileFromHunks(filePath, patch ? parseReviewPatch(patch) : [], patch ? 'patch' : 'unavailable', patch)]
  }
  if (Array.isArray(output.structuredPatch)) {
    const hunks = output.structuredPatch.flatMap((value) => {
      const h = object(value)
      if (!Array.isArray(h.lines) || !h.lines.every((line) => typeof line === 'string')) return []
      return parseReviewPatch(`@@ -${Number(h.oldStart) || 0},${Number(h.oldLines) || 0} +${Number(h.newStart) || 0},${Number(h.newLines) || 0} @@\n${h.lines.join('\n')}`)
    })
    if (hunks.length) return [fileFromHunks(filePath, hunks, 'patch')]
  }
  const edits = Array.isArray(input.edits) ? input.edits : [input]
  const hunks = edits.flatMap((value) => {
    const edit = object(value)
    const before = string(edit.old_string ?? edit.oldString ?? edit.old_str)
    const after = string(edit.new_string ?? edit.newString ?? edit.new_str)
    if (before === undefined || after === undefined) return []
    const lines = [...fragmentLines(before).map((line) => '-' + line), ...fragmentLines(after).map((line) => '+' + line)]
    return parseReviewPatch(`@@ -1 +1 @@\n${lines.join('\n')}`)
  })
  // A Write input does not include the old file. Do not present it as a new
  // file or fetch today's contents and call them the agent's before image.
  return [fileFromHunks(filePath, hunks, hunks.length ? 'fragment' : 'unavailable')]
}
