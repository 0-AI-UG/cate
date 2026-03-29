import React, { useState, useRef, useCallback, useEffect } from "react";

/* ========================================================================== */
/* Types                                                                       */
/* ========================================================================== */

interface PanelData {
  id: string;
  title: string;
  icon: "terminal" | "code" | "browser";
  x: number;
  y: number;
  w: number;
  h: number;
  focused?: boolean;
  termLines?: TermLine[];
}

interface TermLine {
  text: string;
  dim?: boolean;
}

/* ========================================================================== */
/* Cheeky responses                                                            */
/* ========================================================================== */

const RESPONSES = [
  "Nice try — just download the app ;)",
  "Nice try, join the waitlist!",
  "Almost... but this is just a demo",
  "That won't work here. Get the real thing!",
  "Impressive typing, now go sign up",
  "This terminal is decorative. The real one isn't.",
  "sudo get-early-access: permission granted ↑",
  "Error: too cool for a website demo",
];
let responseIdx = 0;
function nextResponse(): string {
  const r = RESPONSES[responseIdx % RESPONSES.length];
  responseIdx++;
  return r;
}

/* ========================================================================== */
/* Icons                                                                       */
/* ========================================================================== */

function iconColor(type: string): string {
  switch (type) {
    case "terminal": return "#4A9EFF";
    case "code": return "#4DD964";
    case "browser": return "#AF52DE";
    default: return "#4A9EFF";
  }
}

function TerminalIcon({ color = "#4A9EFF" }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}
function CodeIcon({ color = "#4DD964" }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function GlobeIcon({ color = "#AF52DE" }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
function PanelIcon({ type }: { type: string }) {
  const c = iconColor(type);
  switch (type) {
    case "code": return <CodeIcon color={c} />;
    case "browser": return <GlobeIcon color={c} />;
    default: return <TerminalIcon color={c} />;
  }
}

/* ========================================================================== */
/* Content renderers                                                           */
/* ========================================================================== */

function TerminalContent({ lines, panelId, onType }: {
  lines: TermLine[];
  panelId: string;
  onType: (panelId: string, input: string) => void;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && input.trim()) {
      onType(panelId, input.trim());
      setInput("");
    }
  };

  return (
    <div
      ref={scrollRef}
      className="p-3 font-mono text-[11.5px] leading-[1.65] overflow-auto h-full cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {lines.map((line, j) => (
        <div key={j} className="whitespace-pre">
          {line.text.startsWith("$") ? (
            <span className="text-white/60">{line.text}</span>
          ) : (
            <span className={line.dim ? "text-white/25" : "text-white/40"}>{line.text}</span>
          )}
        </div>
      ))}
      <div className="flex items-center whitespace-pre">
        <span className="text-white/30">$ </span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          className="bg-transparent border-none outline-none text-white/60 font-mono text-[11.5px] w-full caret-white/50 p-0 m-0"
          spellCheck={false}
          autoComplete="off"
        />
        {!input && <span className="inline-block w-[6px] h-[13px] bg-white/50 cursor-blink" />}
      </div>
    </div>
  );
}

function EditorContent() {
  const lines = [
    { num: 1, text: "import { useEffect, useRef } from 'react'", kw: true },
    { num: 2, text: "import { terminalRegistry } from '../lib/terminalRegistry'", kw: true },
    { num: 3, text: "" },
    { num: 4, text: "export default function TerminalPanel({", kw: true },
    { num: 5, text: "  panelId," },
    { num: 6, text: "  workspaceId," },
    { num: 7, text: "  nodeId," },
    { num: 8, text: "}: TerminalPanelProps) {" },
    { num: 9, text: "  const containerRef = useRef<HTMLDivElement>(null)" },
    { num: 10, text: "" },
    { num: 11, text: "  useEffect(() => {", kw: true },
    { num: 12, text: "    const container = containerRef.current" },
    { num: 13, text: "    if (!container) return" },
    { num: 14, text: "" },
    { num: 15, text: "    terminalRegistry.getOrCreate(panelId, {" },
    { num: 16, text: "      workspaceId," },
    { num: 17, text: "      cwd: rootPath || undefined," },
    { num: 18, text: "    })" },
  ];
  return (
    <div className="p-0 font-mono text-[11px] leading-[1.7] overflow-auto h-full">
      {lines.map((l) => (
        <div key={l.num} className="flex whitespace-pre hover:bg-white/[0.02]">
          <span className="w-8 text-right pr-3 text-white/15 select-none shrink-0">{l.num}</span>
          <span className={l.kw ? "text-white/45" : "text-white/25"}>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function BrowserContent() {
  const [loaded, setLoaded] = useState(false);
  const [consoleInput, setConsoleInput] = useState("");
  const [consoleLogs, setConsoleLogs] = useState<{ type: "log" | "warn" | "error" | "info" | "input"; text: string }[]>([
    { type: "info", text: "DevTools initialized." },
    { type: "log", text: "[HMR] Listening for changes..." },
    { type: "warn", text: "Canvas: 4 panels active, 0 errors" },
  ]);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleLogs]);

  const handleConsoleSubmit = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !consoleInput.trim()) return;
    const input = consoleInput.trim();
    setConsoleInput("");
    setConsoleLogs((prev) => [
      ...prev,
      { type: "input", text: input },
      { type: "log", text: nextResponse() },
    ]);
  };

  const logColor = (type: string) => {
    switch (type) {
      case "error": return "text-red-400";
      case "warn": return "text-yellow-400";
      case "info": return "text-blue-400";
      case "input": return "text-white/60";
      default: return "text-white/40";
    }
  };

  const logPrefix = (type: string) => {
    switch (type) {
      case "error": return "✕";
      case "warn": return "⚠";
      case "info": return "ℹ";
      case "input": return "›";
      default: return " ";
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* URL bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] shrink-0" style={{ backgroundColor: "#1E1E24" }}>
        <div className="flex gap-1.5">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
        <div className="flex-1 bg-white/[0.04] rounded px-2 py-0.5 text-[9px] text-white/30 font-mono flex items-center gap-1">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          en.wikipedia.org
        </div>
      </div>

      {/* Webpage area */}
      <div className="flex-1 overflow-hidden relative" style={{ backgroundColor: "#fff", minHeight: 0 }}>
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1E1E24]">
            <span className="text-[10px] text-white/20 font-mono">Loading...</span>
          </div>
        )}
        <iframe
          src="https://en.m.wikipedia.org/wiki/Integrated_development_environment"
          className="absolute inset-0 w-full h-full border-none"
          title="Browser preview"
          sandbox="allow-scripts allow-same-origin"
          onLoad={() => setLoaded(true)}
        />
      </div>

      {/* Chrome DevTools Console */}
      <div className="shrink-0 border-t border-white/[0.08] flex flex-col" style={{ backgroundColor: "#1b1b1f", height: "35%" }}>
        {/* DevTools tab bar */}
        <div className="flex items-center h-6 px-2 border-b border-white/[0.06] shrink-0 gap-3" style={{ backgroundColor: "#1E1E24" }}>
          <span className="text-[9px] text-white/25 font-mono">Elements</span>
          <span className="text-[9px] text-white/70 font-mono border-b border-blue-400 pb-px">Console</span>
          <span className="text-[9px] text-white/25 font-mono">Network</span>
          <span className="text-[9px] text-white/25 font-mono">Sources</span>
        </div>
        {/* Console logs */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-1 font-mono text-[10px] leading-[1.6]">
          {consoleLogs.map((log, i) => (
            <div key={i} className={`flex gap-1.5 ${log.type === "input" ? "border-t border-white/[0.04] pt-0.5 mt-0.5" : ""}`}>
              <span className={`${logColor(log.type)} shrink-0 w-3 text-center`}>{logPrefix(log.type)}</span>
              <span className={logColor(log.type)}>{log.text}</span>
            </div>
          ))}
          <div ref={consoleEndRef} />
        </div>
        {/* Console input */}
        <div className="flex items-center px-2 py-1 border-t border-white/[0.06] shrink-0">
          <span className="text-[10px] text-blue-400 mr-1.5 font-mono">›</span>
          <input
            type="text"
            value={consoleInput}
            onChange={(e) => setConsoleInput(e.target.value)}
            onKeyDown={handleConsoleSubmit}
            placeholder="Type expression..."
            className="flex-1 bg-transparent border-none outline-none text-[10px] text-white/60 font-mono placeholder:text-white/15 p-0 m-0"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Panels                                                                      */
/* ========================================================================== */

const INITIAL_PANELS: PanelData[] = [
  {
    id: "term-main", title: "~/cate", icon: "terminal", focused: true,
    x: 80, y: 50, w: 300, h: 190,
    termLines: [
      { text: "$ npm run dev" },
      { text: "  electron-vite dev", dim: true },
      { text: "  ✓ main built in 124ms", dim: true },
      { text: "  ✓ preload built in 43ms", dim: true },
      { text: "  ✓ renderer ready in 892ms", dim: true },
      { text: "" },
      { text: "  App running at electron://localhost", dim: true },
    ],
  },
  { id: "editor-1", title: "TerminalPanel.tsx", icon: "code", x: 260, y: 20, w: 380, h: 280 },
  { id: "browser-1", title: "cate.dev", icon: "browser", x: 440, y: 160, w: 400, h: 380 },
  {
    id: "term-test", title: "tests", icon: "terminal",
    x: 150, y: 280, w: 280, h: 170,
    termLines: [
      { text: "$ bun test" },
      { text: "  PASS  canvas.test.ts", dim: true },
      { text: "  PASS  terminal.test.ts", dim: true },
      { text: "  PASS  session.test.ts", dim: true },
      { text: "" },
      { text: "  3 passed, 0 failed" },
    ],
  },
];

/* ========================================================================== */
/* Resize helpers                                                              */
/* ========================================================================== */

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | null;

function detectEdge(x: number, y: number, w: number, h: number, m = 6): Edge {
  const t = y < m, b = y > h - m, l = x < m, r = x > w - m;
  if (t && l) return "nw"; if (t && r) return "ne"; if (b && l) return "sw"; if (b && r) return "se";
  if (t) return "n"; if (b) return "s"; if (l) return "w"; if (r) return "e";
  return null;
}
function edgeCursor(edge: Edge): string {
  switch (edge) {
    case "n": case "s": return "ns-resize";
    case "e": case "w": return "ew-resize";
    case "ne": case "sw": return "nesw-resize";
    case "nw": case "se": return "nwse-resize";
    default: return "";
  }
}
const MIN_W = 180, MIN_H = 100;

/* ========================================================================== */
/* Panel component                                                             */
/* ========================================================================== */

function Panel({ panel, index, isDragging, isResizing, onPointerDown, onClose, onTermType }: {
  panel: PanelData; index: number; isDragging: boolean; isResizing: boolean;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onClose: (id: string) => void;
  onTermType: (id: string, input: string) => void;
}) {
  const [hoverEdge, setHoverEdge] = useState<Edge>(null);
  const [closeHover, setCloseHover] = useState(false);
  const focused = panel.focused && !isDragging;
  const borderClr = focused ? "rgba(74,158,255,0.5)" : isDragging ? "rgba(74,158,255,0.3)" : "rgba(255,255,255,0.1)";
  const shadow = focused ? "0 -2px 8px rgba(74,158,255,0.3)" : isDragging || isResizing ? "0 8px 32px rgba(0,0,0,0.5)" : "0 -1px 4px rgba(0,0,0,0.3)";

  return (
    <div
      className="absolute group"
      style={{
        left: panel.x, top: panel.y, width: panel.w, height: panel.h,
        zIndex: isDragging || isResizing ? 100 : index + 1,
        cursor: hoverEdge ? edgeCursor(hoverEdge) : undefined,
      }}
      onPointerDown={(e) => onPointerDown(e, panel.id)}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setHoverEdge(detectEdge(e.clientX - r.left, e.clientY - r.top, r.width, r.height));
      }}
      onMouseLeave={() => setHoverEdge(null)}
    >
      <div className="flex flex-col h-full" style={{
        backgroundColor: "#1E1E24", border: `1.5px solid ${borderClr}`,
        borderRadius: 8, overflow: "hidden", boxShadow: shadow,
      }}>
        <div className="flex items-center h-7 px-2 select-none cursor-grab active:cursor-grabbing shrink-0" style={{ backgroundColor: "#28282E" }}>
          <div className="flex-shrink-0 mr-1.5"><PanelIcon type={panel.icon} /></div>
          <span className="text-xs font-medium text-white/80 truncate flex-1">{panel.title}</span>
          <button
            className="w-5 h-5 flex items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/30"
            onMouseEnter={() => setCloseHover(true)}
            onMouseLeave={() => setCloseHover(false)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onClose(panel.id)}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke={closeHover ? "#ff5f57" : "rgba(255,255,255,0.5)"} strokeWidth="1.5">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {panel.icon === "terminal" ? (
            <TerminalContent lines={panel.termLines || []} panelId={panel.id} onType={onTermType} />
          ) : panel.icon === "code" ? (
            <EditorContent />
          ) : (
            <BrowserContent />
          )}
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Morphing Toolbar / Waitlist                                                 */
/* ========================================================================== */

function MorphingToolbar({ morph, onAddPanel, onZoomIn, onZoomOut, zoomLevel }: {
  morph: number;
  onAddPanel: (type: "terminal" | "code" | "browser") => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  zoomLevel: number;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setState("loading");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) { setState("done"); setEmail(""); }
      else setState("error");
    } catch { setState("error"); }
  };

  // morph: 0 = toolbar, 1 = waitlist form
  const isWaitlist = morph > 0.5;
  const toolbarOpacity = Math.max(0, 1 - morph * 2);
  const waitlistOpacity = Math.max(0, (morph - 0.4) / 0.6);
  const scale = 1 + morph * 0.15;
  const maxW = 240 + morph * 240; // 240px -> 480px

  return (
    <div id="waitlist" className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30">
      <div
        className="bg-[#2a2a30] border border-white/[0.12] rounded-full shadow-lg flex items-center justify-center overflow-hidden"
        data-no-blur
        style={{
          width: maxW,
          height: 44,
          transform: `scale(${scale})`,
          transition: "width 0.4s cubic-bezier(0.16,1,0.3,1), transform 0.4s cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        {/* Toolbar icons */}
        <div
          className="flex items-center gap-1 px-3 absolute"
          style={{
            opacity: toolbarOpacity,
            pointerEvents: isWaitlist ? "none" : "auto",
            transition: "opacity 0.3s",
          }}
        >
          <button onClick={() => onAddPanel("terminal")} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/[0.15] transition-all"><TerminalIcon /></button>
          <button onClick={() => onAddPanel("browser")} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/[0.15] transition-all"><GlobeIcon /></button>
          <button onClick={() => onAddPanel("code")} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/[0.15] transition-all"><CodeIcon /></button>
          <div className="w-px h-5 bg-white/[0.15] mx-1" />
          <button onClick={onZoomOut} className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.15] transition-all">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <span className="text-xs font-mono text-white/70 min-w-[44px] text-center select-none">{Math.round(zoomLevel * 100)}%</span>
          <button onClick={onZoomIn} className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.15] transition-all">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>

        {/* Waitlist form — no opacity on container, use visibility + individual opacity */}
        <div
          className="absolute inset-0 flex items-center"
          style={{
            visibility: isWaitlist ? "visible" : "hidden",
            pointerEvents: isWaitlist ? "auto" : "none",
          }}
        >
          {state === "done" ? (
            <span className="text-sm text-white/50 text-center w-full">You're on the list.</span>
          ) : (
            <form onSubmit={handleSubmit} className="flex items-stretch w-full h-full pl-5 pr-[3px] py-[3px]">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                required
                className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder:text-white/20"
              />
              <button
                type="submit"
                disabled={state === "loading"}
                style={email.trim() ? { backgroundColor: "#ffffff", color: "#000000" } : undefined}
                className={`text-xs font-medium px-6 rounded-full shrink-0 transition-all ${
                  email.trim()
                    ? "hover:brightness-95"
                    : "bg-white/10 text-white/30"
                } disabled:opacity-50`}
              >
                {state === "loading" ? "..." : "Join waitlist"}
              </button>
            </form>
          )}
        </div>
      </div>
      {state === "error" && isWaitlist && (
        <p className="text-xs text-white/30 mt-2 text-center">Something went wrong. Try again.</p>
      )}
    </div>
  );
}

/* ========================================================================== */
/* CanvasHero                                                                  */
/* ========================================================================== */

let panelCounter = 10;

export function CanvasHero() {
  const [panels, setPanels] = useState(INITIAL_PANELS);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizing, setResizing] = useState<{ id: string; edge: Edge; startX: number; startY: number; startRect: { x: number; y: number; w: number; h: number } } | null>(null);
  const [panning, setPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 }); // canvas pan offset
  const [zoom, setZoom] = useState(1);
  const [scrollExpand, setScrollExpand] = useState(0);
  const [toolbarMorph, setToolbarMorph] = useState(0);
  const [screenWidth, setScreenWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1440);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelAreaRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      setScreenWidth(window.innerWidth);
      if (!wrapperRef.current) return;
      const rect = wrapperRef.current.getBoundingClientRect();
      const windowH = window.innerHeight;

      const expandStart = windowH * 0.65;
      const expandEnd = windowH * 0.25;
      setScrollExpand(1 - Math.max(0, Math.min(1, (rect.top - expandEnd) / (expandStart - expandEnd))));

      const canvasBottom = rect.bottom;
      const morphStart = windowH + 200;
      const morphEnd = windowH - 100;
      const morphProgress = 1 - Math.max(0, Math.min(1, (canvasBottom - morphEnd) / (morphStart - morphEnd)));
      setToolbarMorph(morphProgress);
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    update();
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);

  // Cmd+scroll = zoom only, normal scroll passes through to page
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        setZoom((z) => Math.min(2, Math.max(0.3, z - e.deltaY * 0.002)));
      }
      // Otherwise let normal page scroll happen
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const handleTermType = useCallback((panelId: string, input: string) => {
    setPanels((prev) =>
      prev.map((p) => {
        if (p.id !== panelId) return p;
        return { ...p, termLines: [...(p.termLines || []), { text: `$ ${input}` }, { text: nextResponse(), dim: true }] };
      })
    );
  }, []);

  const handleClose = useCallback((id: string) => {
    setPanels((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // Add new panel from toolbar
  const addPanel = useCallback((type: "terminal" | "code" | "browser") => {
    panelCounter++;
    const id = `${type}-${panelCounter}`;
    const cx = -panOffset.x / zoom + 300;
    const cy = -panOffset.y / zoom + 200;
    const jitter = () => (Math.random() - 0.5) * 60;
    const newPanel: PanelData = {
      id,
      title: type === "terminal" ? "~/new" : type === "code" ? "untitled.ts" : "localhost",
      icon: type,
      x: cx + jitter(),
      y: cy + jitter(),
      w: type === "code" ? 360 : type === "browser" ? 340 : 300,
      h: type === "code" ? 280 : type === "browser" ? 300 : 200,
      focused: true,
      termLines: type === "terminal" ? [{ text: "$ _" }] : undefined,
    };
    setPanels((prev) => [...prev.map((p) => ({ ...p, focused: false })), newPanel]);
  }, [panOffset, zoom]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(2, z + 0.1)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.3, z - 0.1)), []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent, panelId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const panel = panels.find((p) => p.id === panelId);
      if (!panel || !containerRef.current) return;

      const panelEl = e.currentTarget;
      const panelRect = panelEl.getBoundingClientRect();
      const edge = detectEdge(e.clientX - panelRect.left, e.clientY - panelRect.top, panelRect.width, panelRect.height);

      setPanels((prev) => {
        const copy = prev.map((p) => ({ ...p, focused: p.id === panelId }));
        const idx = copy.findIndex((p) => p.id === panelId);
        if (idx === -1) return copy;
        const [item] = copy.splice(idx, 1);
        copy.push(item);
        return copy;
      });

      if (edge) {
        setResizing({ id: panelId, edge, startX: e.clientX, startY: e.clientY, startRect: { x: panel.x, y: panel.y, w: panel.w, h: panel.h } });
      } else {
        const area = panelAreaRef.current || containerRef.current;
        const rect = area!.getBoundingClientRect();
        setDragOffset({ x: (e.clientX - rect.left) / zoom - panel.x, y: (e.clientY - rect.top) / zoom - panel.y });
        setDragging(panelId);
      }
    },
    [panels, zoom]
  );

  // Canvas background drag = pan
  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    // Only start pan if clicking on the canvas background itself
    if (e.target === containerRef.current || e.target === panelAreaRef.current || (e.target as HTMLElement).tagName === "rect" || (e.target as HTMLElement).tagName === "svg") {
      setPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    }
  }, [panOffset]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (panning) {
        setPanOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      } else if (dragging) {
        const area = panelAreaRef.current || containerRef.current;
        if (!area) return;
        const rect = area.getBoundingClientRect();
        setPanels((prev) => prev.map((p) =>
          p.id === dragging ? { ...p, x: (e.clientX - rect.left) / zoom - dragOffset.x, y: (e.clientY - rect.top) / zoom - dragOffset.y } : p
        ));
      } else if (resizing) {
        const dx = (e.clientX - resizing.startX) / zoom;
        const dy = (e.clientY - resizing.startY) / zoom;
        const { x, y, w, h } = resizing.startRect;
        const edge = resizing.edge!;
        let nx = x, ny = y, nw = w, nh = h;
        if (edge.includes("e")) nw = Math.max(MIN_W, w + dx);
        if (edge.includes("w")) { nw = Math.max(MIN_W, w - dx); nx = x + (w - nw); }
        if (edge.includes("s")) nh = Math.max(MIN_H, h + dy);
        if (edge.includes("n")) { nh = Math.max(MIN_H, h - dy); ny = y + (h - nh); }
        setPanels((prev) => prev.map((p) => p.id === resizing.id ? { ...p, x: nx, y: ny, w: nw, h: nh } : p));
      }
    },
    [panning, panStart, dragging, dragOffset, resizing, zoom]
  );

  const onPointerUp = useCallback(() => { setDragging(null); setResizing(null); setPanning(false); }, []);

  // Start at 900px max-width (like T3), expand to full viewport on scroll
  const borderRadius = Math.round(16 * (1 - scrollExpand));
  const startMaxWidth = Math.min(900, screenWidth - 80); // contained card width at top
  const currentMaxWidth = startMaxWidth + scrollExpand * (screenWidth - startMaxWidth);

  // Center offset: as the container grows wider, shift the inner panel area
  // so panels stay visually centered and don't drift with the expanding edges
  const panelAreaOffset = (currentMaxWidth - startMaxWidth) / 2;

  return (
    <>
      <div ref={wrapperRef} className="relative mt-8">
        <div
          className="mx-auto"
          style={{
            maxWidth: currentMaxWidth,
            borderRadius,
            overflow: "hidden",
            border: scrollExpand < 0.95 ? "1px solid rgba(255,255,255,0.08)" : "none",
            boxShadow: scrollExpand < 0.95
              ? `0 20px 60px -15px rgba(0,0,0,${0.5 * (1 - scrollExpand)}), 0 0 0 0.5px rgba(255,255,255,${0.05 * (1 - scrollExpand)})`
              : "none",
          }}
        >
          <div
            ref={containerRef}
            className="relative w-full select-none overflow-hidden"
            style={{
              height: "150vh",
              backgroundColor: "#1E1E24",
              cursor: panning ? "grabbing" : dragging ? "grabbing" : resizing ? edgeCursor(resizing.edge) : "grab",
            }}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            {/* Dot grid — moves with pan and scales with zoom */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <pattern id="dotgrid" width={20 * zoom} height={20 * zoom} patternUnits="userSpaceOnUse"
                  x={panOffset.x % (20 * zoom)} y={panOffset.y % (20 * zoom)}>
                  <circle cx={10 * zoom} cy={10 * zoom} r={Math.max(0.5, 0.8 * zoom)} fill="rgba(255,255,255,0.12)" />
                </pattern>
                <pattern id="gridlines" width={100 * zoom} height={100 * zoom} patternUnits="userSpaceOnUse"
                  x={panOffset.x % (100 * zoom)} y={panOffset.y % (100 * zoom)}>
                  <path d={`M ${100 * zoom} 0 L 0 0 0 ${100 * zoom}`} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#dotgrid)" />
              <rect width="100%" height="100%" fill="url(#gridlines)" />
            </svg>

            {/* Panel area — zoom + pan + centered offset */}
            <div
              ref={panelAreaRef}
              className="absolute"
              style={{
                left: panelAreaOffset,
                top: 0,
                width: startMaxWidth,
                height: "100%",
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                transformOrigin: "0 0",
              }}
            >
              {panels.map((panel, i) => (
                <Panel
                  key={panel.id}
                  panel={panel}
                  index={i}
                  isDragging={dragging === panel.id}
                  isResizing={resizing?.id === panel.id}
                  onPointerDown={onPointerDown}
                  onClose={handleClose}
                  onTermType={handleTermType}
                />
              ))}
            </div>

            {/* Footer text at bottom of canvas */}
            <div className="absolute bottom-0 left-0 right-0 py-6 px-8 sm:px-12 z-10 flex items-center justify-between">
              <span className="text-xs text-white/20">CATE</span>
              <a
                href="https://github.com/nicepaulhorn/cate"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-white/20 hover:text-white/40 transition-colors"
              >
                GitHub
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Fixed toolbar / waitlist at viewport bottom */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
        <div className="pointer-events-auto">
          <MorphingToolbar morph={toolbarMorph} onAddPanel={addPanel} onZoomIn={zoomIn} onZoomOut={zoomOut} zoomLevel={zoom} />
        </div>
      </div>
    </>
  );
}
