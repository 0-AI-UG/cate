// Typing a prompt into an agent CLI as the person would: one paste, then
// Enter. Shared by the terminal agents and the live CLI test that pins the
// CLIs' behavior (live/promptInput.itest.ts).

/** The terminal a prompt is typed into. */
export interface PromptTerminal {
  write(data: string): void
  /** Calls `listener` on the program's output; returns the unsubscribe. */
  onOutput(listener: () => void): () => void
}

/** Most a paste waits for the program to answer it before its Enter goes
 *  anyway (a program that draws nothing for a paste). */
const PASTE_ANSWER_MAX_MS = 2_000

/** Pastes `prompt` and submits it. The Enter goes once the program answered
 *  the paste with output, so the program reads it as input of its own:
 *  Cursor drops an Enter it reads together with the paste. */
export async function typePrompt(terminal: PromptTerminal, prompt: string, bracketed: boolean): Promise<void> {
  const text = prompt.replace(/\r?\n/g, '\r')
  let off = (): void => {}
  const answered = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PASTE_ANSWER_MAX_MS)
    off = terminal.onOutput(() => {
      clearTimeout(timer)
      resolve()
    })
  })
  try {
    terminal.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text)
    await answered
  } finally {
    off()
  }
  terminal.write('\r')
}
