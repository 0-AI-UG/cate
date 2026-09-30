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
        line: num.int().min(1).flag('line', 'number'),
        side: opt(oneOf('old', 'new'), 'new'),
        body: str.nonEmpty().flag('body', 'text'),
        severity: opt(oneOf('info', 'warning', 'error'), 'warning'),
      },
    },
    'note.resolve': {
      access: 'control',
      handler: 'session',
      target: 'sticky',
      summary: 'Resolve a note by id or unique prefix',
      args: { noteId: str.nonEmpty().pos('note-id') },
    },
  },
  {
    area: 'agent',
    help: 'Without --panel, the target selected by `cate panel set <id>` is used.',
  },
)
