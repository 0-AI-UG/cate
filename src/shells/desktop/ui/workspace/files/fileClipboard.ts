// Copy / Paste of files: refs on the system clipboard as `cate-file://` text,
// so a copy in one window or workspace pastes in any other. Needs the
// `clipboard` feature; without it the actions are not offered.

import { clientUi } from '@kernel/interaction'
import { fileRefsFromText, fileRefsToText, type FileRef } from '@workspace/files/contract'

export function canCopyFiles(): boolean {
  const ui = clientUi()
  return !!ui.writeClipboard && !!ui.readClipboard
}

export async function copyFileRefs(refs: readonly FileRef[]): Promise<void> {
  if (refs.length > 0) await clientUi().writeClipboard?.(fileRefsToText(refs))
}

/** The file refs on the clipboard; empty when it holds anything else. */
export async function clipboardFileRefs(): Promise<FileRef[]> {
  const text = await clientUi().readClipboard?.().catch(() => '')
  return fileRefsFromText(text ?? '')
}
