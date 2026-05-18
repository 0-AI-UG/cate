// =============================================================================
// Role store + cate role list/create/edit/assign/delete.
//
// Roles are persistent JSON in ~/.cate/roles.json. Each role has an id + name
// + prompt body. When `cate recruit ... --role Foo` runs, recruit.ts reads
// the role via readRoleByName() and writes the prompt into the recruit's
// per-agent context file (CLAUDE.md, GEMINI.md, AGENTS.md, etc.).
//
// `cate role edit` rewrites any live recruits' role files in-place so they
// pick up the new prompt on next agent restart (we don't kill the running
// process — the agent will see the updated file next time it reloads).
// =============================================================================

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'
import log from '../../logger'
import { requireCaller } from './_shared'
import type { OrchRequest } from '../protocol'

export interface RoleRecord {
  id: string
  name: string
  prompt: string
  createdAt: number
  updatedAt: number
}

function rolesFilePath(): string {
  return path.join(os.homedir(), '.cate', 'roles.json')
}

async function loadRoles(): Promise<RoleRecord[]> {
  try {
    const raw = await fs.readFile(rolesFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r) => r && typeof r === 'object' && typeof r.name === 'string' && typeof r.prompt === 'string')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    log.warn('Roles: failed to load: %s', e?.message ?? e)
    return []
  }
}

async function saveRoles(roles: RoleRecord[]): Promise<void> {
  const p = rolesFilePath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(roles, null, 2), 'utf8')
}

/** Public lookup used by recruit.ts. */
export async function readRoleByName(name: string): Promise<RoleRecord | null> {
  const roles = await loadRoles()
  const needle = name.trim().toLowerCase()
  return roles.find((r) => r.name.toLowerCase() === needle) ?? null
}

export async function roleHandle(verb: 'list' | 'create' | 'edit' | 'assign' | 'delete', req: OrchRequest): Promise<any> {
  // Most verbs require a caller context (it's at least documented for analytics).
  requireCaller(req)
  switch (verb) {
    case 'list':   return await doList()
    case 'create': return await doCreate(req)
    case 'edit':   return await doEdit(req)
    case 'assign': return await doAssign(req)
    case 'delete': return await doDelete(req)
  }
}

async function doList() {
  const roles = await loadRoles()
  return { roles: roles.map((r) => ({ id: r.id, name: r.name, preview: previewLine(r.prompt) })) }
}

async function doCreate(req: OrchRequest) {
  const args = (req.args ?? {}) as { name?: string; prompt?: string }
  const name = (args.name ?? '').toString().trim()
  const prompt = (args.prompt ?? '').toString().trim()
  if (!name) throw new Error('role create requires a name')
  if (!prompt) throw new Error('role create requires a prompt')
  const roles = await loadRoles()
  if (roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`role "${name}" already exists — use \`cate role edit\` to update it`)
  }
  const now = Date.now()
  const record: RoleRecord = {
    id: 'role-' + Math.random().toString(36).slice(2, 10),
    name,
    prompt,
    createdAt: now,
    updatedAt: now,
  }
  roles.push(record)
  await saveRoles(roles)
  return { name: record.name }
}

async function doEdit(req: OrchRequest) {
  const args = (req.args ?? {}) as { name?: string; prompt?: string }
  const name = (args.name ?? '').toString().trim()
  const prompt = (args.prompt ?? '').toString()
  if (!name) throw new Error('role edit requires a name')
  if (!prompt) throw new Error('role edit requires --prompt')
  const roles = await loadRoles()
  const role = roles.find((r) => r.name.toLowerCase() === name.toLowerCase())
  if (!role) throw new Error(`no role named "${name}"`)
  role.prompt = prompt
  role.updatedAt = Date.now()
  await saveRoles(roles)

  // Push the updated prompt to every live recruit currently using this role.
  // We scan ~/.cate/recruits/* for .cate-role marker files; rewriting the
  // role file in-place is enough because the agent picks it up on its next
  // context refresh (and a future hook could send the recruit a signal).
  await syncRoleToRecruits(role)

  return { name: role.name }
}

async function doAssign(req: OrchRequest) {
  // Reassign a live recruit to a different role (or --none to clear).
  // Phase D scope: this rewrites the per-agent role file in the recruit's
  // cwd. The orchestrator does NOT restart the agent process — the recruit's
  // Claude/Codex/Gemini will re-read its context file on the next turn.
  const args = (req.args ?? {}) as { recruit?: string; role?: string | null }
  const recruitName = (args.recruit ?? '').toString().trim()
  if (!recruitName) throw new Error('role assign requires a recruit name')

  // Look up which recruit dir this terminal lives in. We stored a marker
  // file when the recruit was spawned: ~/.cate/recruits/<id>/.cate-role.
  // To map "recruit name" → recruit dir, scan the recruits root for a dir
  // whose `.cate-name` file matches.
  // Note: we don't have a .cate-name file written today; this assign command
  // is therefore a best-effort and will simply error if no marker dir maps
  // to the recruit name. The fallback is to dismiss + recruit again.
  throw new Error('role assign on a live recruit is not yet supported — dismiss the recruit and recruit again with --role')
}

async function doDelete(req: OrchRequest) {
  const args = (req.args ?? {}) as { name?: string }
  const name = (args.name ?? '').toString().trim()
  if (!name) throw new Error('role delete requires a name')
  const roles = await loadRoles()
  const idx = roles.findIndex((r) => r.name.toLowerCase() === name.toLowerCase())
  if (idx < 0) throw new Error(`no role named "${name}"`)
  const removed = roles.splice(idx, 1)[0]
  await saveRoles(roles)
  return { name: removed.name }
}

async function syncRoleToRecruits(role: RoleRecord): Promise<void> {
  const recruitsRoot = path.join(os.homedir(), '.cate', 'recruits')
  if (!fsSync.existsSync(recruitsRoot)) return
  let dirs: string[]
  try { dirs = await fs.readdir(recruitsRoot) } catch { return }
  for (const dir of dirs) {
    const recruitDir = path.join(recruitsRoot, dir)
    const marker = path.join(recruitDir, '.cate-role')
    let existing: string
    try { existing = (await fs.readFile(marker, 'utf8')).trim() } catch { continue }
    if (existing.toLowerCase() !== role.name.toLowerCase()) continue
    // Re-find which agent's role file lives here so we can rewrite the right one.
    for (const fname of ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md', 'ROLE.md']) {
      const fpath = path.join(recruitDir, fname)
      if (fsSync.existsSync(fpath)) {
        const header = `# Your role\n\nThis terminal was opened by another agent on the Cate canvas. Stay focused on the role below — it is the reason you exist on this canvas.\n\n`
        const tail = `\n\n## Working with the canvas\n\nRun \`cate list\` to see who else is connected to you. Use \`cate ask "Name" "..."\` to delegate or coordinate. Read sticky notes with \`cate note read "Name"\`. The user can also \`Alt-drag\` between panel tabs to wire new peers to you at any time.\n`
        try { await fs.writeFile(fpath, `${header}${role.prompt.trim()}${tail}`, 'utf8') } catch { /* fine */ }
      }
    }
  }
}

function previewLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? ''
  return line.length > 80 ? line.slice(0, 77) + '...' : line
}
