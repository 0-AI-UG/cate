import { expect, test } from 'vitest'
import { AGENT_HOOK_SPECS } from '../../contract'
import { HOOK_LIFECYCLE_CASES, NATIVE_HOOK_KINDS, PI_MANUAL_COMPACTION_CASES, CONVERSATION_RESET_COMMANDS, selectHookLifecycleCases } from './hookLifecycle.config'

test('real CLI scenarios cover every hook Cate installs', () => {
  expect(Object.keys(HOOK_LIFECYCLE_CASES).sort()).toEqual(Object.keys(AGENT_HOOK_SPECS).sort())
  for (const [agent, spec] of Object.entries(AGENT_HOOK_SPECS)) {
    const exercised = new Set(Object.values(HOOK_LIFECYCLE_CASES[agent as keyof typeof HOOK_LIFECYCLE_CASES]).flat())
    if (agent === 'pi') for (const scenario of PI_MANUAL_COMPACTION_CASES) for (const name of scenario.hooks) exercised.add(name)
    for (const name of exercised) expect(NATIVE_HOOK_KINDS[name], `normalized expectation: ${name}`).toBeDefined()
    const installed: string[] = []
    for (const file of spec.projectFiles ?? []) {
      const content = file.build(null, { bridgeCommand: '/fixture/cate-hook-bridge' })!
      if (agent === 'opencode') {
        installed.push(...JSON.parse(content.match(/const TRACKED = new Set\((\[[^\n]+\])\)/)![1]))
      } else if (agent === 'pi') {
        installed.push(...[...content.matchAll(/pi\.on\("([^"]+)"/g)].map((match) => match[1]).filter((name) => name !== 'tool_execution_start'))
      } else {
        const { hooks } = JSON.parse(content)
        installed.push(...(Array.isArray(hooks) ? hooks.map((hook: { trigger: string }) => hook.trigger) : Object.keys(hooks)))
      }
    }
    expect([...exercised].sort(), agent).toEqual([...new Set(installed)].sort())
  }
})

test('unknown and empty lifecycle selections fail instead of silently skipping', () => {
  for (const selection of ['', 'edit,', 'interupt']) expect(() => selectHookLifecycleCases('codex', selection)).toThrow('Unknown hook lifecycle case')
  expect(selectHookLifecycleCases('codex', 'edit,resume')).toEqual(['edit', 'resume'])
})

test('every CLI runs the same native reset/switch contract in CI', () => {
  expect(Object.keys(CONVERSATION_RESET_COMMANDS).sort()).toEqual(Object.keys(AGENT_HOOK_SPECS).sort())
  for (const [agent, command] of Object.entries(CONVERSATION_RESET_COMMANDS)) {
    expect(command, agent).toMatch(/^\/\S+$/)
    expect(HOOK_LIFECYCLE_CASES[agent as keyof typeof HOOK_LIFECYCLE_CASES], agent).toHaveProperty('session-reset')
  }
})
