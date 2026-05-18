// =============================================================================
// Note handlers — `cate note create/read/write/edit/list`.
//
// All note IO happens in the renderer (sticky notes live in canvasStore.
// annotations). We just call across via the render bridge and translate the
// CLI envelope.
// =============================================================================

import { requireCaller, callRendererForCaller } from './_shared'
import type { OrchRequest } from '../protocol'

export async function noteHandle(verb: 'create' | 'read' | 'write' | 'edit' | 'list', req: OrchRequest): Promise<any> {
  const ctx = requireCaller(req)
  const args = req.args ?? {}

  switch (verb) {
    case 'create': {
      const a = args as { content?: string }
      // Auto-connect every note to the caller's node so `cate list` can see it.
      const created = await callRendererForCaller<{ annotationId: string; name: string }>(ctx, 'createNote', {
        content: a.content ?? '',
        connectToNodeId: ctx.nodeId,
        connectToPanelId: ctx.panelId,
      })
      return { name: created.name, id: created.annotationId }
    }

    case 'read': {
      const a = args as { name?: string; startLine?: number; numLines?: number }
      if (!a.name) throw new Error('note read requires a name')
      return await callRendererForCaller(ctx, 'readNote', a)
    }

    case 'write': {
      const a = args as { name?: string; content?: string }
      if (!a.name) throw new Error('note write requires a name')
      if (typeof a.content !== 'string') throw new Error('note write requires content')
      return await callRendererForCaller(ctx, 'writeNote', a)
    }

    case 'edit': {
      const a = args as { name?: string; oldText?: string; newText?: string }
      if (!a.name) throw new Error('note edit requires a name')
      if (!a.oldText) throw new Error('note edit requires old text')
      if (typeof a.newText !== 'string') throw new Error('note edit requires new text')
      return await callRendererForCaller(ctx, 'editNote', a)
    }

    case 'list': {
      return await callRendererForCaller(ctx, 'listNotes', {})
    }
  }
}
