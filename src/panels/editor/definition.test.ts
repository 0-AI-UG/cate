import { expect, it } from 'vitest'
import { editorDefinition } from './definition'

const record = (filePath: string) => ({ id: 'e', type: 'editor' as const, title: 'Untitled', fields: { filePath } })

it('describes a file by its path, and a draft by nothing', () => {
  expect(editorDefinition.describe?.(record('/repo/notes.md'))).toBe('/repo/notes.md')
  expect(editorDefinition.describe?.(record('/repo/.cate/tmp/0f8fad5b-d9cb-469f-a165-70867728950e.md'))).toBeUndefined()
})
