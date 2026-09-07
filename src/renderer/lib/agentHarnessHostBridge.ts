/** Narrow request/reply bridge for the pinned T3 client adapter. No Electron API
 * is exposed to the guest. Cate validates every request against the owning panel. */
export function agentHarnessHostBridgeScript(token: string): string {
  return `(() => {
    if (window.__cateHost) return;
    const pending = new Map();
    const request = (action, payload) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Panel handoff timed out. The conversation is available in the conversation picker.'));
      }, ['place-agent', 'file', 'diff'].includes(action) ? 120000 : 30000);
      pending.set(id, { resolve, reject, timer });
      console.info('cate-chat-host:' + JSON.stringify({ token: ${JSON.stringify(token)}, id, action, payload }));
    });
    const fire = (action, payload) => { void request(action, payload).catch(() => {}); };
    // In particular, PR links in messages must not open a hidden T3 surface.
    document.addEventListener('click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link) return;
      const url = new URL(link.href, location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      fire('external', { url: url.href });
    }, true);
    window.__cateHost = {
      request,
      cancelPending() {
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Conversation changed. Please try again.'));
        }
        pending.clear();
      },
      reply(id, result, error) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        error ? entry.reject(new Error(error)) : entry.resolve(result);
      },
      shortcut(command) {
        if (command === 'diff.toggle') { fire('diff', {}); return true; }
        return command.startsWith('terminal.') || command.startsWith('rightPanel.') || command.startsWith('script.');
      },
    };
    const installed = new WeakSet();
    const install = () => {
      const chat = window.__cateChat;
      if (!chat?.store || installed.has(chat.store)) return;
      installed.add(chat.store);
      const state = chat.store.getState();
      if (chat.threadRef) state.close(chat.threadRef);
      const originalOpen = state.open;
      const openSurface = (ref, kind) => {
        if (kind === 'agents') return originalOpen(ref, kind);
        if (kind === 'diff') fire('diff', { threadId: ref.threadId });
      };
      // Route every file/diff entry point, including inline cards. The remaining
      // workspace surfaces have no launchers in the embedded guest.
      chat.store.setState({
        open: openSurface,
        toggle: openSurface,
        // Only T3's inline agent activity controls may open this surface.
        // Generic visibility controls can dismiss it, but cannot launch it.
        toggleVisibility: (ref) => state.close(ref),
        openFile: (ref, filePath) => fire('file', { threadId: ref.threadId, filePath }),
        openPullRequest: () => {},
        openBrowser: () => {},
        openTerminal: () => {},
      });
    };
    install();
    new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
  })()`
}
