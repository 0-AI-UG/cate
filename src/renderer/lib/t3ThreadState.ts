import type { AgentState } from '../../shared/types'

/** Fields from t3@0.0.38's OrchestrationThreadShell, not provider-process state. */
export interface T3Thread {
  id: string
  title: string
  latestTurn?: { state: string } | null
  session?: { status: string; activeTurnId: string | null } | null
  hasPendingApprovals?: boolean
  hasPendingUserInput?: boolean
  hasActionableProposedPlan?: boolean
  backgroundLiveness?: 'working' | 'monitoring' | null
}

export function t3ThreadActivity(thread: T3Thread): AgentState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan) return 'waitingForInput'
  if (thread.session?.status === 'starting' || thread.latestTurn?.state === 'running' || thread.session?.activeTurnId || thread.backgroundLiveness) return 'running'
  // A stopped turn leaves the conversation ready for the user's next message,
  // just like a terminal agent returning to its prompt.
  return thread.latestTurn ? 'waitingForInput' : 'notRunning'
}

/** A separate authenticated subscription in the guest's persistent session.
 * Only shell metadata crosses the guest boundary; never conversation content.
 * Navigation destroys this connection. Reconnection starts from a full snapshot.
 */
export const T3_THREAD_SUBSCRIPTION_SCRIPT = `(() => {
  if (window.__cateT3Threads) return;
  const state = window.__cateT3Threads = { connected: false, threads: {}, revision: 0, sequence: 0, dirty: new Set(), removed: new Set(), fullPending: true };
  let socket;
  let timer;
  const connect = () => {
    socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
    socket.onopen = () => socket.send(JSON.stringify({ _tag: 'Request', id: 'cate-shell', tag: 'orchestration.subscribeShell', payload: {}, headers: [] }));
    socket.onmessage = ({ data }) => {
      try {
        const decoded = JSON.parse(data);
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          if (message._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); continue; }
          if (message.requestId !== 'cate-shell') continue;
          if (message._tag === 'Exit') { socket.close(); continue; }
          if (message._tag !== 'Chunk') continue;
          for (const event of message.values) {
            const pick = t => ({ id: t.id, title: t.title, latestTurn: t.latestTurn, session: t.session,
              hasPendingApprovals: t.hasPendingApprovals, hasPendingUserInput: t.hasPendingUserInput,
              hasActionableProposedPlan: t.hasActionableProposedPlan, backgroundLiveness: t.backgroundLiveness });
            if (event.kind === 'snapshot') {
              state.threads = Object.fromEntries(event.snapshot.threads.map(t => [t.id, pick(t)]));
              state.sequence = event.snapshot.snapshotSequence ?? 0;
              state.fullPending = true;
              state.dirty.clear(); state.removed.clear();
              state.connected = true;
            } else if (event.kind === 'thread-upserted') {
              state.threads[event.thread.id] = pick(event.thread);
              state.dirty.add(event.thread.id); state.removed.delete(event.thread.id);
            } else if (event.kind === 'thread-removed') {
              delete state.threads[event.threadId];
              state.dirty.delete(event.threadId); state.removed.add(event.threadId);
            }
            if (typeof event.sequence === 'number') state.sequence = event.sequence;
            state.revision++;
          }
          socket.send(JSON.stringify({ _tag: 'Ack', requestId: message.requestId }));
        }
      } catch { socket.close(); }
    };
    socket.onclose = () => { state.connected = false; state.revision++; timer = setTimeout(connect, 2000); };
    socket.onerror = () => socket.close();
  };
  const dispose = state.dispose = () => {
    clearTimeout(timer); socket.onclose = null; socket.close();
    window.removeEventListener('pagehide', dispose);
    delete window.__cateT3Threads;
  };
  window.addEventListener('pagehide', dispose, { once: true });
  connect();
})()`


/** Keep unchanged thread lists inside the guest instead of cloning them over
 * IPC on every tick. A fresh consumer (or a failed read) requests a full copy. */
export function t3ThreadPollScript(previousRevision?: number): string {
  return `/* cate-t3-poll */ (() => {
    ${T3_THREAD_SUBSCRIPTION_SCRIPT};
    const state = window.__cateT3Threads;
    if (state.revision === ${previousRevision === undefined ? 'null' : JSON.stringify(previousRevision)}) return;
    const previous = ${previousRevision === undefined ? 'null' : JSON.stringify(previousRevision)};
    const full = previous === null || previous !== state.lastReadRevision || state.fullPending || !state.dirty;
    const threads = full ? state.threads : Object.fromEntries([...state.dirty].map(id => [id, state.threads[id]]));
    const result = { connected: state.connected, threads, revision: state.revision, sequence: state.sequence,
      ...(full ? {} : { full: false, removed: [...state.removed] }) };
    state.lastReadRevision = state.revision; state.fullPending = false;
    state.dirty?.clear(); state.removed?.clear();
    return result;
  })()`
}
