// `cate.review.*`: handled by the review panel's session. The target is an
// explicit panel or the sticky one; a review is never picked implicitly.

import { defineCateApi, num, oneOf, opt, str } from '@kernel/api/contract'

export const reviewApi = defineCateApi(
  'review',
  {
    inspect: {
      access: 'read',
      handler: 'session',
      target: 'sticky',
      summary: 'Print the comparison, files and notes',
      format: 'prettyJson',
    },
    complete: {
      access: 'control',
      handler: 'session',
      target: 'sticky',
      summary: 'Mark the review done (the assigned review agent only)',
    },
    'note.add': {
      access: 'control',
      handler: 'session',
      target: 'sticky',
      summary: 'Record a finding on a diff line',
      args: {
        file: str.nonEmpty().flag('file', 'path').help('Path as listed by review inspect'),
        line: num.int().min(1).flag('line', 'number').help('Line number on the chosen side of the diff'),
        side: opt(oneOf('old', 'new'), 'new').help('Which side of the diff the line is on'),
        body: str.nonEmpty().flag('body', 'text').help('The finding'),
        severity: opt(oneOf('info', 'warning', 'error'), 'warning').help('How serious the finding is'),
      },
    },
    'note.resolve': {
      access: 'control',
      handler: 'session',
      target: 'sticky',
      summary: 'Resolve a note by id or unique prefix',
      args: { noteId: str.nonEmpty().pos('note-id').help('Note id or unique prefix, from cate review inspect') },
    },
  },
  { area: 'agent', summary: 'Inspect review panels and record findings' },
)
