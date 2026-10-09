import { expect, it } from 'vitest'
import { editorDraftDirectory, editorDraftPath, isEditorDraft } from './drafts'

it('places drafts under the checkout\'s .cate/tmp', () => {
  const draft = editorDraftPath('/repo/', '0f8fad5b-d9cb-469f-a165-70867728950e')
  expect(draft).toBe('/repo/.cate/tmp/0f8fad5b-d9cb-469f-a165-70867728950e.md')
  expect(isEditorDraft(draft)).toBe(true)
  expect(editorDraftDirectory(draft)).toBe('/repo/.cate/tmp')
})
