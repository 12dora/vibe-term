import type { LinkSession } from '@vibeterm/shared/link';
import { forwardLinkDeadlineFor } from './forwarder-deadline';
import { linkSessionClosed } from './forwarder-link-state';
import type { PeerLinkProvider, PeerTransportKind } from './mesh-deps';
import { transportOfLink } from './pending-measure-hold';
import { NodeUnreachableError } from './types';

export type FailoverLinkPick = LinkSession | null | 'terminal' | 'aborted';

export async function pickFailoverLink(
  peers: PeerLinkProvider,
  nodeId: string,
  signal: AbortSignal,
  dead: boolean
): Promise<FailoverLinkPick> {
  if (dead) return 'aborted';
  const deadlineMs = forwardLinkDeadlineFor(nodeId, peers.rttOf?.(nodeId), peers);
  return raceFailoverLink(peers.getLink(nodeId), signal, deadlineMs);
}

export function openedLinkTransport(
  peers: PeerLinkProvider,
  nodeId: string,
  link: LinkSession
): PeerTransportKind | null {
  const known = transportOfLink(link);
  if (known) return known;
  return peers.transportOf?.(nodeId) ?? null;
}

/** 撤销 / 暂停 / 未准入再拨也不会通。暂时没有链路仍按普通失败重试。 */
function hardUnreachable(err: unknown): boolean {
  if (!(err instanceof NodeUnreachableError)) return false;
  return (
    err.message === 'revoked' ||
    err.message === 'paused' ||
    err.message === 'untrusted' ||
    err.message === 'not admitted'
  );
}

async function raceFailoverLink(
  pending: Promise<LinkSession>,
  signal: AbortSignal,
  deadlineMs: number
): Promise<FailoverLinkPick> {
  let failure: unknown = null;
  const guarded = pending.then(
    (link) => link,
    (err: unknown) => {
      failure = err;
      return null;
    }
  );
  const timeout = abortOrTimeout(signal, deadlineMs);
  try {
    const winner = await Promise.race([
      guarded.then((link) => ({ kind: 'link' as const, link })),
      timeout.promise,
    ]);
    if (signal.aborted) return 'aborted';
    if (hardUnreachable(failure)) return 'terminal';
    if (winner.kind !== 'link' || !winner.link) {
      void guarded.catch(() => undefined);
      return null;
    }
    if (await linkSessionClosed(winner.link)) return null;
    return winner.link;
  } finally {
    timeout.cancel();
  }
}

function abortOrTimeout(
  signal: AbortSignal,
  deadlineMs: number
): { promise: Promise<{ kind: 'timeout' }>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<{ kind: 'timeout' }>((resolve) => {
    const finish = () => resolve({ kind: 'timeout' });
    if (signal.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, Math.max(1, deadlineMs));
    timer.unref?.();
    onAbort = () => {
      if (timer) clearTimeout(timer);
      finish();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}
