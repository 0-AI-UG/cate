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

  tool("cate_layout", "Read or arrange the canvas",
    [
      "Inspect or rearrange the whole canvas. Choose `op` (default 'get'):",
      "- 'get': return the canvas — open panels (id, type, title, position, size, focused, isSelf) and viewport.",
      "- 'arrange': lay panels out. {style: tile|grid|cascade|focus-one, panelIds? (limit scope)}.",
    ].join("\n"),
    Type.Object({
      op: Type.Optional(Type.Union([Type.Literal("get"), Type.Literal("arrange")])),
      style: Type.Optional(Type.String()),
      panelIds: Type.Optional(Type.Array(Type.String())),
    }), "layout")

  tool("cate_panel", "Open or manage a panel",
    [
      "Open or manage a single canvas panel. Choose `op`:",
      "- 'open': create/open a panel, focus + center it. {type: editor|terminal|browser|git|fileExplorer|document, target?, placement?}. target: {path,line?,column?,preview?} for editor (preview:true = open a markdown file straight into rendered preview); {url} for browser; {cwd?,command?} for terminal.",
      "- 'focus' | 'close': {panelId}.",
      "- 'move': {panelId, placement:{relativeTo,position}}.",
      "- 'resize': {panelId, preset: small|medium|large} or {panelId, size:{width,height}}.",
      "- 'preview': toggle a markdown editor's rendered preview. {panelId, preview?:bool (default true)}.",
      "(To navigate a browser panel use cate_browser; to lay out many panels use cate_layout op:'arrange'.)",
    ].join("\n"),
    Type.Object({
      op: Type.Union([
        Type.Literal("open"), Type.Literal("focus"), Type.Literal("move"),
        Type.Literal("resize"), Type.Literal("close"), Type.Literal("preview"),
      ]),
      panelId: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      target: Type.Optional(Type.Object({
        path: Type.Optional(Type.String()), line: Type.Optional(Type.Number()), column: Type.Optional(Type.Number()),
        url: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), command: Type.Optional(Type.String()),
        preview: Type.Optional(Type.Boolean()),
      })),
      placement: Placement,
      preset: Type.Optional(Type.String()),
      size: Type.Optional(Type.Object({ width: Type.Number(), height: Type.Number() })),
      preview: Type.Optional(Type.Boolean()),
    }), "panel")

  tool("cate_browser", "Navigate a browser panel",
    "Point a browser panel at a url (opens a new browser panel if no panelId). {panelId?, url}.",
    Type.Object({ panelId: Type.Optional(Type.String()), url: Type.String() }), "browser")

  tool("cate_terminal", "Run or read a terminal",
    [
      "Drive a terminal panel. Choose `op`:",
      "- 'run': run a shell command. {command, panelId? (reuse an existing terminal), newPanel?:bool (force a fresh one)}.",
      "- 'read': read recent output (visible screen + scrollback) as text. {panelId, lines?:number (trailing lines, default 50, max 1000)}.",
    ].join("\n"),
    Type.Object({
      op: Type.Union([Type.Literal("run"), Type.Literal("read")]),
      panelId: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      newPanel: Type.Optional(Type.Boolean()),
      lines: Type.Optional(Type.Number()),
    }), "terminal")
}
