import { expect, test } from 'vitest'
import { AGENT_HOOK_SPECS } from '../../contract'
import { HERMES_PLUGIN_MANIFEST } from '../hooks/hermes'
import { HOOK_LIFECYCLE_CASES, NATIVE_HOOK_KINDS, selectHookLifecycleCases } from './hookLifecycle.config'

test('real CLI scenarios cover every hook Cate installs', () => {
  expect(Object.keys(HOOK_LIFECYCLE_CASES).sort()).toEqual(Object.keys(AGENT_HOOK_SPECS).sort())
  for (const [agent, spec] of Object.entries(AGENT_HOOK_SPECS)) {
    const exercised = new Set(Object.values(HOOK_LIFECYCLE_CASES[agent as keyof typeof HOOK_LIFECYCLE_CASES]).flat())
    for (const name of exercised) expect(NATIVE_HOOK_KINDS[name], `normalized expectation: ${name}`).toBeDefined()
    const installed: string[] = []
    if (agent === 'hermes') installed.push(...[...HERMES_PLUGIN_MANIFEST.matchAll(/^ {2}- (\w+)$/gm)].map((match) => match[1]))
    for (const file of spec.projectFiles ?? []) {
      const content = file.build(null, { bridgeCommand: '/fixture/cate-hook-bridge' })!
      if (agent === 'opencode') {
        installed.push(...JSON.parse(content.match(/const TRACKED = new Set\((\[[^\n]+\])\)/)![1]))
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
