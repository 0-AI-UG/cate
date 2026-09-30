// Page-side lookups the perf specs share. They read the new client through the
// e2e harness and the DOM: a browser panel's guest lives in the persistent
// surface host (`[data-browser-surface="<panelId>"]`), a chat panel's guest
// is `webview[data-chat-webview]`, and a terminal's PTY id is in its session
// snapshot.

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

type Guest = HTMLElement & { getWebContentsId(): number }

/** Installs `window.__perfE2E` in the page (idempotent). */
export async function installPerfHelpers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __perfE2E?: unknown }
    if (w.__perfE2E) return
    const guestId = (selector: string): number | null => {
      const guest = document.querySelector(selector) as Guest | null
      try { return guest ? guest.getWebContentsId() : null } catch { return null }
    }
    w.__perfE2E = {
      browserWebContentsId: (panelId: string) => guestId(`[data-browser-surface="${panelId}"] webview`),
      chatWebContentsId: (panelId: string) => guestId(`webview[data-chat-webview="${panelId}"]`),
      chatReady: (panelId: string) => !!document.querySelector(`webview[data-chat-webview="${panelId}"][data-chat-guest-ready="true"]`),
      panelOfNode: (nodeId: string) => window.__cateE2E!.nodes().find((n) => n.id === nodeId)?.panelId ?? null,
      async ptyIdOfNode(nodeId: string) {
        const panelId = window.__cateE2E!.nodes().find((n) => n.id === nodeId)?.panelId
        return panelId ? (window as unknown as { __perfE2E: { ptyId(p: string): Promise<string | null> } }).__perfE2E.ptyId(panelId) : null
      },
      async writeNode(nodeId: string, data: string) {
        const panelId = window.__cateE2E!.nodes().find((n) => n.id === nodeId)?.panelId
        if (panelId) await window.__cateE2E!.writeTerminal(panelId, data)
      },
      async textOfNode(nodeId: string) {
        const panelId = window.__cateE2E!.nodes().find((n) => n.id === nodeId)?.panelId
        return panelId ? window.__cateE2E!.terminalText(panelId) : ''
      },
      async ptyId(panelId: string, workspaceId?: string) {
        const snap = await window.__cateE2E!.sessionSnapshot(panelId, workspaceId, 2000) as { ptyId?: string | null } | null
        return snap?.ptyId ?? null
      },
    }
  })
}

declare global {
  interface Window {
    __perfE2E?: {
      browserWebContentsId(panelId: string): number | null
      chatWebContentsId(panelId: string): number | null
      chatReady(panelId: string): boolean
      ptyId(panelId: string, workspaceId?: string): Promise<string | null>
      panelOfNode(nodeId: string): string | null
      ptyIdOfNode(nodeId: string): Promise<string | null>
      writeNode(nodeId: string, data: string): Promise<void>
      textOfNode(nodeId: string): Promise<string>
    }
  }
}

/** Creates `type` on the active canvas at `origin`; returns ids. */
export async function create(page: Page, type: string, origin: { x: number; y: number }, options: Record<string, unknown> = {}): Promise<{ panelId: string; nodeId: string }> {
  const created = await page.evaluate(({ type, origin, options }) => window.__cateE2E!.createOnCanvas(type, origin, options), { type, origin, options })
  if (!created) throw new Error(`could not create ${type}`)
  return created
}

export async function waitForPty(page: Page, panelId: string, timeout = 15_000): Promise<string> {
  let id: string | null = null
  await expect.poll(async () => (id = await page.evaluate((p) => window.__perfE2E!.ptyId(p), panelId)), { timeout }).not.toBeNull()
  return id!
}

export async function waitForBrowserGuest(page: Page, panelId: string, timeout = 15_000): Promise<number> {
  let id: number | null = null
  await expect.poll(async () => (id = await page.evaluate((p) => window.__perfE2E!.browserWebContentsId(p), panelId)), { timeout }).not.toBeNull()
  return id!
}
