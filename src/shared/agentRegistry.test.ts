// =============================================================================
// Registry coverage — the forget-proofing the compiler cannot express.
//
// Most per-agent tables are TOTAL `Record<AgentId, …>`, so adding an agent id
// is already a compile error until each is filled in. Three things escape that:
//
//   • the skills targets, because AgentDef.skills is nullable (an agent Cate
//     installs no skills for is legitimate) — so nothing catches a NEW agent
//     that silently forgot its skills dir;
//   • the SkillTargetId union, which must stay exactly `cate-agent` plus the
//     ids the agents declare, or a target resolves to no skills root;
//   • the logo map, which is renderer-only (it imports SVG assets) and so can
//     never be keyed by a shared Record.
//
// These assert those. A NEW agent is expected to fail the skills and logo cases
// until it is either wired up or listed as a deliberate omission below.
// =============================================================================

import { describe, expect, test } from 'vitest'
import { AGENTS, agentForSkillTarget, type AgentId } from './agents'
import { AGENT_HOOK_SPECS } from './agentHooks'
import { SKILL_TARGETS, type SkillTargetId } from './skills'

/** Agents deliberately without a skills integration. Add an id here ONLY with a
 *  reason — the point of the failure is to force the decision, not to be muted. */
const NO_SKILLS: ReadonlySet<AgentId> = new Set([])

/** Agents deliberately without a bundled logo (they fall back to the panel's
 *  default icon). */
const NO_LOGO: ReadonlySet<AgentId> = new Set([])

describe('agent registry coverage', () => {
  test('every agent declares a skills target, or is an explicit omission', () => {
    for (const a of AGENTS) {
      if (NO_SKILLS.has(a.id)) {
        expect(a.skills, `${a.id} is listed as skill-less`).toBeNull()
        continue
      }
      expect(a.skills, `${a.id} has no skills target — declare one or add it to NO_SKILLS`).toBeTruthy()
      // A skills root that is not workspace-relative would escape the workspace.
      expect(a.skills!.baseSegments.length).toBeGreaterThan(0)
      for (const seg of a.skills!.baseSegments) {
        expect(seg, `${a.id} skills segment`).not.toContain('/')
        expect(seg).not.toBe('..')
      }
    }
  })

  test('SKILL_TARGETS is exactly cate-agent plus every agent-declared target', () => {
    const declared = AGENTS.flatMap((a) => (a.skills ? [a.skills.targetId] : []))
    expect([...SKILL_TARGETS].map((t) => t.id).sort()).toEqual([...declared, 'cate-agent'].sort())
    // Every target resolves back to its agent (or is Cate's own).
    for (const t of SKILL_TARGETS) {
      if (t.id === 'cate-agent') {
        expect(agentForSkillTarget(t.id)).toBeNull()
        continue
      }
      expect(agentForSkillTarget(t.id)?.skills?.targetId, `${t.id} resolves to its agent`).toBe(t.id)
      expect(t.label, `${t.id} has a label`).toBeTruthy()
    }
  })

  test('target ids and skills roots are unique — no two agents share a dir', () => {
    const ids = AGENTS.flatMap((a) => (a.skills ? [a.skills.targetId] : []))
    expect(new Set(ids).size, 'duplicate targetId').toBe(ids.length)
    const roots = AGENTS.flatMap((a) => (a.skills ? [a.skills.baseSegments.join('/')] : []))
    expect(new Set(roots).size, 'two agents installing to the same dir').toBe(roots.length)
  })

  // The persisted ids in every workspace's .cate/skills.json. Renaming one
  // orphans existing installs, so this is a deliberate tripwire, not a
  // restatement of the type.
  test('persisted SkillTargetId values never drift', () => {
    const expected: SkillTargetId[] = [
      'claude-code', 'cate-agent', 'pi-native', 'opencode', 'codex', 'cursor', 'grok',
    ]
    expect([...SKILL_TARGETS].map((t) => t.id).sort()).toEqual([...expected].sort())
  })

  test('every agent has a hook spec', () => {
    // Total Record, so this is belt-and-braces — but it also catches a spec
    // that is present and empty (no injection channel at all).
    for (const a of AGENTS) {
      const spec = AGENT_HOOK_SPECS[a.id]
      expect(spec, `${a.id} hook spec`).toBeTruthy()
      expect(spec.projectFiles?.length, `${a.id} has no project-file injection channel`).toBeTruthy()
    }
  })

  test('every agent has a launch command and a resume decision', () => {
    for (const a of AGENTS) {
      expect(a.command, `${a.id} command`).toBeTruthy()
      expect(a.matchProcess(a.command.toLowerCase()) || a.id === 'claude-code',
        `${a.id} does not detect its own command name`).toBe(true)
      // resumeArgs is nullable by design (a CLI may not resume by id) — assert
      // it is a real decision, and that the argv it builds is non-empty.
      if (a.resumeArgs) expect(a.resumeArgs('abc').length).toBeGreaterThan(0)
    }
  })
})

// The logo map lives in the renderer (it imports .svg assets), so it cannot be
// a shared Record. This test reaches into it from the node env via a static
// read of the module's key list instead of importing the assets.
describe('agent logo coverage', () => {
  test('every agent has a logo entry, or is an explicit omission', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../renderer/lib/agent/agentLogos.ts', import.meta.url), 'utf-8'),
    )
    // The LOGO_BY_ID object literal — keys only, so this needs no bundler.
    const body = src.slice(src.indexOf('const LOGO_BY_ID'), src.indexOf('// displayName → logo'))
    for (const a of AGENTS) {
      if (NO_LOGO.has(a.id)) continue
      const key = /^[a-z]+$/.test(a.id) ? a.id : `'${a.id}'`
      expect(body.includes(`${key}:`), `${a.id} has no logo — add one or list it in NO_LOGO`).toBe(true)
    }
  })
})
