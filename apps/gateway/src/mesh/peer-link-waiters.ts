import type { LinkSession } from '@tmex/shared/link';
import type { PeerManagerState } from './peer-manager-state';
import type { LiveWaiter, TransportWaiter } from './peer-manager-types';
import type { PeerTransportKind } from './types';

export type PeerLinkWaitersDeps = {
  maybeUpgrade: (nodeId: string, opts: { cooldown: boolean; userPath?: boolean }) => void;
};

/** 链路就绪与传输类型的等待者登记：谁在等 live、谁在等升到指定 transport。 */
export class PeerLinkWaiters {
  private readonly state: PeerManagerState;
  private readonly deps: PeerLinkWaitersDeps;

  constructor(state: PeerManagerState, deps: PeerLinkWaitersDeps) {
    this.state = state;
    this.deps = deps;
  }

  async waitForTransport(
    nodeId: string,
    kind: PeerTransportKind,
    timeoutMs: number
  ): Promise<boolean> {
    if ((this.state.live.get(nodeId)?.transport ?? null) === kind) return true;
    if (this.state.stopped || timeoutMs <= 0) return false;
    return new Promise((resolve) => {
      let settled = false;
      const timeoutAbort = new AbortController();
      const onStop = () => timeoutAbort.abort();
      this.state.stopAbort.signal.addEventListener('abort', onStop, { once: true });
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.state.stopAbort.signal.removeEventListener('abort', onStop);
        timeoutAbort.abort();
        const list = this.state.transportWaiters.get(nodeId);
        if (list) {
          const next = list.filter((row) => row !== waiter);
          if (next.length > 0) this.state.transportWaiters.set(nodeId, next);
          else this.state.transportWaiters.delete(nodeId);
        }
        resolve(ok);
      };
      const waiter: TransportWaiter = { kind, resolve: finish };
      const list = this.state.transportWaiters.get(nodeId) ?? [];
      list.push(waiter);
      this.state.transportWaiters.set(nodeId, list);
      void this.state.scheduler.sleep(timeoutMs, timeoutAbort.signal).then(
        () => finish(false),
        () => {
          if (!settled) finish(false);
        }
      );
    });
  }

  notifyTransport(nodeId: string): void {
    const current = this.state.live.get(nodeId)?.transport ?? null;
    const waiters = this.state.transportWaiters.get(nodeId);
    if (!waiters || waiters.length === 0) return;
    const keep: TransportWaiter[] = [];
    for (const waiter of waiters) {
      if (current === waiter.kind) waiter.resolve(true);
      else keep.push(waiter);
    }
    if (keep.length > 0) this.state.transportWaiters.set(nodeId, keep);
    else this.state.transportWaiters.delete(nodeId);
  }

  failTransportWaiters(nodeId: string): void {
    const waiters = this.state.transportWaiters.get(nodeId);
    if (!waiters || waiters.length === 0) return;
    this.state.transportWaiters.delete(nodeId);
    for (const waiter of waiters) waiter.resolve(false);
  }

  notifyLive(nodeId: string, session: LinkSession): void {
    const waiters = this.state.liveWaiters.get(nodeId);
    if (!waiters || waiters.length === 0) return;
    this.state.liveWaiters.delete(nodeId);
    for (const waiter of waiters) waiter.resolve(session);
  }

  private waitForLive(nodeId: string): { promise: Promise<LinkSession>; cancel: () => void } {
    let waiter: LiveWaiter | undefined;
    const promise = new Promise<LinkSession>((resolve) => {
      waiter = { resolve };
      const list = this.state.liveWaiters.get(nodeId) ?? [];
      list.push(waiter);
      this.state.liveWaiters.set(nodeId, list);
    });
    return {
      promise,
      cancel: () => {
        if (!waiter) return;
        const list = this.state.liveWaiters.get(nodeId);
        if (!list) return;
        const next = list.filter((row) => row !== waiter);
        if (next.length > 0) this.state.liveWaiters.set(nodeId, next);
        else this.state.liveWaiters.delete(nodeId);
      },
    };
  }

  async awaitEstablishedOrDial(nodeId: string, dial: Promise<LinkSession>): Promise<LinkSession> {
    const current = this.state.live.get(nodeId);
    if (current) return current.session;
    const liveWait = this.waitForLive(nodeId);
    try {
      const winner = await Promise.race([
        dial.then(
          (session) => ({ ok: true as const, session }),
          (err: unknown) => ({ ok: false as const, err })
        ),
        liveWait.promise.then((session) => ({ ok: true as const, session })),
      ]);
      const live = this.state.live.get(nodeId);
      if (live) {
        this.deps.maybeUpgrade(nodeId, { cooldown: true, userPath: true });
        return live.session;
      }
      if (!winner.ok) throw winner.err;
      return winner.session;
    } finally {
      liveWait.cancel();
    }
  }
}
