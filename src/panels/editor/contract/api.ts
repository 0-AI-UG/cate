// `cate.editor.*`. `openFile` creates (or reuses) an editor panel, so the
// editor module serves it as a service; `active` asks the target editor session.

import { defineCateApi, defineCliArea, num, opt, path } from '@kernel/api/contract'

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

/** The CLI permission area of these methods. */
export const editorCliArea = defineCliArea({
  label: 'Files',
  read: {
    key: 'cliEditorReadEnabled',
    code: 'editor-read-disabled',
    detail: 'Read which file the active editor panel is showing.',
  },
  control: {
    key: 'cliEditorControlEnabled',
    code: 'editor-control-disabled',
    detail: '`cate editor open <path[:line]>`: open a file in Files, including image, PDF and DOCX previews.',
  },
})

export const editorApi = defineCateApi(
  'editor',
  {
    openFile: {
      access: 'control',
      handler: 'service',
      summary: 'Open a file in the workspace, optionally at a line',
      args: {
        path: path.pos('path[:line[:column]]').help('File to open, relative to this directory'),
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
  { area: editorCliArea, summary: 'Open files in editor panels' },
)
