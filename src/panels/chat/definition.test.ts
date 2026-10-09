import { expect, it, vi } from 'vitest'
import { definitionProblems, type PanelKit } from '@panels/framework/contract'
import { chatDefinition } from './definition'

it('is a valid panel definition', () => {
  expect(definitionProblems(chatDefinition)).toEqual([])
  expect(chatDefinition.icon).toBe('t3')
})

it('creates a numbered chat bound to the given thread and checkout', () => {
  const add = vi.fn(() => 'new')
  const kit = {
    newId: () => 'new',
    record: (type, init) => ({ id: init.id, type, title: init.title ?? 'T3 Code', fields: init.fields ?? {}, ...(init.worktreeId ? { worktreeId: init.worktreeId } : {}) }),
    add,
    numberedTitle: () => 'T3 Code 2',
    worktreeIdForPath: (path) => path === '/repo-wt' ? 'wt' : undefined,
  } as Partial<PanelKit> as PanelKit
  expect(chatDefinition.create({ threadId: 'one', cwd: '/repo-wt', near: 'p' }, kit)).toBe('new')
  expect(add).toHaveBeenCalledWith(
    { id: 'new', type: 'chat', title: 'T3 Code 2', worktreeId: 'wt', fields: { threadId: 'one', cwd: '/repo-wt' } },
    { threadId: 'one', cwd: '/repo-wt', near: 'p' },
  )
})
