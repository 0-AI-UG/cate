// `cate.editor.*`. `openFile` creates (or reuses) an editor panel, so the
// editor module serves it as a service; `active` asks the target editor session.

import { defineCateApi, num, opt, path } from '@kernel/api/contract'

const FILE_TARGET = /^(.+?):(\d+)(?::(\d+))?$/

/** Splits `path:line[:column]` when no explicit line was given. */
function splitFileTarget(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.path !== 'string' || args.line !== undefined) return args
  const match = FILE_TARGET.exec(args.path)
  if (!match) return args
  return {
    ...args,
    path: match[1],
    line: Number(match[2]),
    ...(match[3] === undefined ? {} : { column: Number(match[3]) }),
  }
}

export const editorApi = defineCateApi(
  'editor',
  {
    openFile: {
      access: 'control',
      handler: 'service',
      summary: 'Open a file in the workspace, optionally at a line',
      args: {
        path: path.pos('path[:line[:column]]'),
        line: opt(num.int().min(1)).help('Reveal this line'),
        column: opt(num.int().min(1)).help('Reveal this column'),
      },
      format: 'createdPanel',
      cli: { command: ['editor', 'open'], transform: splitFileTarget },
    },
    active: {
      access: 'read',
      handler: 'session',
      summary: 'Print which file the target editor shows',
    },
  },
  { area: 'editor' },
)
