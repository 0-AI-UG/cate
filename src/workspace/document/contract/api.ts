// `cate.panel.*` and `cate.canvas.*`: panels as document records. Served by
// workspace/document's runtime side. `cate.panel.focus` is gone: focus is
// client state.

import { bool, defineCateApi, num, obj, opt, panel, path, str } from '@kernel/api/contract'

export const panelApi = defineCateApi(
  'panel',
  {
    list: {
      access: 'read',
      handler: 'service',
      summary: 'List the open panels',
      format: 'panelList',
    },
    close: {
      access: 'control',
      handler: 'service',
      summary: 'Close a panel',
      args: {
        panelId: panel().pos().help('Panel id or unique prefix, from cate panel list'),
        discard: opt(bool, false).help('Discard unsaved changes instead of failing with dirty'),
      },
    },
    setTitle: {
      access: 'control',
      handler: 'service',
      summary: 'Rename a panel (defaults to the calling panel)',
      args: {
        title: str.nonEmpty().rest('title').help('The new title'),
        panelId: opt(panel()).flag('panel', 'id').help('Panel to rename (default: the calling panel)'),
      },
      cli: { command: ['panel', 'title'] },
    },
    'target.set': {
      access: 'read',
      handler: 'service',
      summary: 'Select the panel later commands target',
      args: { panelId: panel().pos().help('Panel id or unique prefix, from cate panel list') },
      format: 'panelTarget',
      cli: { command: ['panel', 'set'] },
    },
    'target.current': {
      access: 'read',
      handler: 'service',
      summary: 'Print the selected panel',
      format: 'panelTarget',
      cli: { command: ['panel', 'current'] },
    },
    'target.clear': {
      access: 'read',
      handler: 'service',
      summary: 'Clear the selected panel',
      cli: { command: ['panel', 'clear'] },
    },
  },
  { area: 'panel', summary: 'List, create, select, rename and close panels' },
)

export const canvasApi = defineCateApi(
  'canvas',
  {
    createPanel: {
      access: 'control',
      handler: 'service',
      summary: 'Create a panel next to the calling panel',
      args: {
        type: str.nonEmpty().pos('browser|terminal|canvas').help('The panel type'),
        url: opt(str).pos('url').help('Browser panels: the page to open'),
        filePath: opt(path).flag('file', 'path').help('Editor panels: the file to open'),
        position: opt(obj({ x: num, y: num })).hidden(),
      },
      format: 'createdPanel',
      cli: { command: ['panel', 'create'] },
    },
  },
  { area: 'panel' },
)
