import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

// Inlined sentinel (must equal CATE_SENTINEL in src/shared/cateControl.ts).
// Pi loads this file via jiti from the workspace dir, where @shared can't resolve.
const CATE_SENTINEL = "@@cate-control@@"

type CateResponse = { ok: boolean; result?: unknown; error?: string; denied?: boolean }

async function sendControlRequest(ctx: any, action: string, params: Record<string, unknown>): Promise<CateResponse> {
  const payload = CATE_SENTINEL + JSON.stringify({ action, params })
  const raw = await ctx.ui.input(payload)
  if (typeof raw !== "string") return { ok: false, error: "no response from Cate (cancelled or timed out)" }
  try { return JSON.parse(raw) as CateResponse }
  catch { return { ok: false, error: "malformed response from Cate" } }
}

function toResult(action: string, res: CateResponse) {
  const text = res.ok
    ? `${action} ok: ${JSON.stringify(res.result ?? {})}`
    : res.denied ? `${action} denied by user` : `${action} failed: ${res.error ?? "unknown error"}`
  return { content: [{ type: "text" as const, text }], details: res }
}

const Placement = Type.Optional(Type.Object({
  relativeTo: Type.Optional(Type.String({ description: "panelId or 'self'" })),
  position: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("left"), Type.Literal("above"), Type.Literal("below")])),
}))

export default function (pi: ExtensionAPI) {
  const tool = (name: string, label: string, description: string, parameters: any, action: string) =>
    pi.registerTool({
      name, label, description, parameters,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return toResult(action, await sendControlRequest(ctx, action, params as Record<string, unknown>))
      },
    })

  tool("cate_get_layout", "Read Cate layout",
    "Return the current canvas: open panels (id, type, title, position, size, focused, isSelf) and viewport.",
    Type.Object({}), "get_layout")

  tool("cate_open_panel", "Open a panel",
    "Open (or re-focus) a panel on the canvas, then center the view on it. type: editor|terminal|browser|git|fileExplorer|document. target: {path,line?,preview?} for editor (preview:true opens a markdown file straight into rendered preview); {url} for browser; {cwd?,command?} for terminal. Optional semantic placement.",
    Type.Object({
      type: Type.String(),
      target: Type.Optional(Type.Object({
        path: Type.Optional(Type.String()), line: Type.Optional(Type.Number()), column: Type.Optional(Type.Number()),
        url: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), command: Type.Optional(Type.String()),
        preview: Type.Optional(Type.Boolean()),
      })),
      placement: Placement,
    }), "open_panel")

  tool("cate_close_panel", "Close a panel", "Close a panel by id.", Type.Object({ panelId: Type.String() }), "close_panel")
  tool("cate_focus_panel", "Focus a panel", "Focus a panel and center it in view.", Type.Object({ panelId: Type.String() }), "focus_panel")
  tool("cate_move_panel", "Move a panel", "Move a panel using semantic placement.", Type.Object({ panelId: Type.String(), placement: Placement }), "move_panel")
  tool("cate_resize_panel", "Resize a panel", "Resize a panel by preset (small|medium|large) or explicit {width,height}.",
    Type.Object({ panelId: Type.String(), preset: Type.Optional(Type.String()), size: Type.Optional(Type.Object({ width: Type.Number(), height: Type.Number() })) }), "resize_panel")
  tool("cate_arrange", "Arrange panels", "Arrange panels: tile|grid|cascade|focus-one. Optional panelIds to limit scope.",
    Type.Object({ layout: Type.String(), panelIds: Type.Optional(Type.Array(Type.String())) }), "arrange")
  tool("cate_run_in_terminal", "Run in terminal", "Run a shell command in a terminal panel (opens one if newPanel). Use cate_read_terminal afterwards to read the output.",
    Type.Object({ panelId: Type.Optional(Type.String()), command: Type.String(), newPanel: Type.Optional(Type.Boolean()) }), "run_in_terminal")
  tool("cate_read_terminal", "Read terminal output",
    "Read the recent visible + scrollback output of a terminal panel as plain text (for inspecting command results). lines = how many trailing lines to return (default 50, max 1000).",
    Type.Object({ panelId: Type.String(), lines: Type.Optional(Type.Number()) }), "read_terminal")
  tool("cate_open_url", "Open a URL", "Open or navigate a browser panel to a URL.",
    Type.Object({ panelId: Type.Optional(Type.String()), url: Type.String() }), "open_url")
  tool("cate_set_markdown_preview", "Toggle markdown preview", "Show (preview:true) or hide (preview:false) the rendered markdown preview for an open editor panel. Markdown files only.",
    Type.Object({ panelId: Type.String(), preview: Type.Optional(Type.Boolean()) }), "set_markdown_preview")
}
