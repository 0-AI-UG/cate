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
  relativeTo: Type.Optional(Type.String({ description: "panel id (e.g. \"a1b2c3\") or 'self'" })),
  position: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("left"), Type.Literal("above"), Type.Literal("below")])),
}))

const CATE_TOOLS = ["cate_layout", "cate_panel", "cate_browser", "cate_terminal"]

export default function (pi: ExtensionAPI) {
  // On/off without a reload: the tools are always registered, but we add/remove
  // them from the session's ACTIVE set, which is what gets advertised to the
  // model. Inactive => the agent never sees them and spends no tokens on their
  // definitions. The renderer flips this live by firing /cate-on | /cate-off
  // (like /plan); the env var seeds the initial state for a fresh session.
  let desired = process.env.CATE_CONTROL_ENABLED !== "0"
  const apply = () => {
    const active = new Set(pi.getActiveTools())
    for (const t of CATE_TOOLS) { if (desired) active.add(t); else active.delete(t) }
    pi.setActiveTools([...active])
  }
  const setEnabled = (on: boolean) => { desired = on; apply() }
  // Re-apply on every session start/resume/reload so the live state survives.
  pi.on("session_start", () => apply())
  pi.registerCommand("cate-on", { description: "Enable Cate panel control.", handler: async () => setEnabled(true) })
  pi.registerCommand("cate-off", { description: "Disable Cate panel control.", handler: async () => setEnabled(false) })

  const tool = (name: string, label: string, description: string, parameters: any, action: string) =>
    pi.registerTool({
      name, label, description, parameters,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return toResult(action, await sendControlRequest(ctx, action, params as Record<string, unknown>))
      },
    })

  tool("cate_layout", "Read the canvas",
    "Return the open panels - {id, title, type, focused, isSelf} for each. Target panels in the other cate tools by their `id` (e.g. \"a1b2c3\") - it is stable. `title` is only a display label and changes (a browser's title becomes the page title, etc.).",
    Type.Object({}), "layout")

  tool("cate_panel", "Open, close, or move a panel",
    [
      "Open, close, or move a canvas panel. Choose `op`:",
      "- 'open': create a panel. {type: editor|terminal|browser|document, target?, placement?}. target: {path,line?,column?,preview?} for editor (preview:true opens a markdown file straight into rendered preview); {url} for browser; {cwd?,command?} for terminal. Returns the new panel's {id, title} - keep the id to target it later.",
      "- 'close': {panel} - the panel id.",
      "- 'move': {panel, placement:{relativeTo,position}} - reposition relative to another panel.",
      "`panel` and placement.relativeTo are panel IDs like \"a1b2c3\" (from cate_layout or an open result), or 'self' for your own panel. This never pans or zooms the user's view.",
    ].join("\n"),
    Type.Object({
      op: Type.Union([Type.Literal("open"), Type.Literal("close"), Type.Literal("move")]),
      panel: Type.Optional(Type.String({ description: "panel id (for close / move)" })),
      type: Type.Optional(Type.String()),
      target: Type.Optional(Type.Object({
        path: Type.Optional(Type.String()), line: Type.Optional(Type.Number()), column: Type.Optional(Type.Number()),
        url: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), command: Type.Optional(Type.String()),
        preview: Type.Optional(Type.Boolean()),
      })),
      placement: Placement,
    }), "panel")

  tool("cate_browser", "Control a browser panel",
    [
      "Drive a browser panel. Choose `op`:",
      "- 'navigate': load a url. {panel, url}.",
      "- 'back' | 'forward' | 'reload' | 'stop': history / loading control. {panel}.",
      "- 'info': report the current {url, title, canGoBack, canGoForward}. {panel}.",
      "- 'read': the page's visible text, or one CSS selector's text. {panel, selector?}.",
      "- 'eval': run JavaScript in the page and return its result (use this to click, fill, or scroll). {panel, js}.",
      "- 'screenshot': capture the page to an image file. {panel}.",
      "`panel` is a panel id (e.g. \"a1b2c3\", from cate_layout or the open result).",
    ].join("\n"),
    Type.Object({
      op: Type.Union([
        Type.Literal("navigate"), Type.Literal("back"), Type.Literal("forward"),
        Type.Literal("reload"), Type.Literal("stop"), Type.Literal("info"),
        Type.Literal("read"), Type.Literal("eval"), Type.Literal("screenshot"),
      ]),
      panel: Type.String({ description: "panel id, e.g. \"a1b2c3\"" }),
      url: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String({ description: "CSS selector for read" })),
      js: Type.Optional(Type.String({ description: "JavaScript to run in the page for eval" })),
    }), "browser")

  tool("cate_terminal", "Run or read a terminal",
    [
      "Drive a terminal panel. Choose `op`:",
      "- 'run': run a shell command. {command, panel? (reuse an existing terminal by id), newPanel?:bool (force a fresh one)}. Returns the terminal's {id, title}.",
      "- 'read': read recent output (visible screen + scrollback) as text. {panel, lines?:number (trailing lines, default 50, max 1000)}.",
      "`panel` is a panel id (e.g. \"a1b2c3\").",
    ].join("\n"),
    Type.Object({
      op: Type.Union([Type.Literal("run"), Type.Literal("read")]),
      panel: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      newPanel: Type.Optional(Type.Boolean()),
      lines: Type.Optional(Type.Number()),
    }), "terminal")
}
