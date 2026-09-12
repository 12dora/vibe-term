import { NodeUnreachableError } from './types';

export function peerKnownRelayOnline(input: {
  nodeId: string;
  relaysFor?: (nodeId: string) => readonly string[];
  onlineUnion?: () => ReadonlySet<string> | Iterable<string>;
}): boolean {
  if ((input.relaysFor?.(input.nodeId).length ?? 0) > 0) return true;
  const union = input.onlineUnion?.();
  if (!union) return false;
  if ('has' in union && typeof union.has === 'function') {
    return union.has(input.nodeId);
  }
  for (const id of union) {
    if (id === input.nodeId) return true;
  }
  return false;
}

export type DirectDialResult<T> = {
  session: T | null;
  pending: Promise<T | null> | null;
};

/**
 * 前台取链：直连竞速与中继并行。先到的会话胜出。
 * 直连先成则 abort 中继（输家就地关掉，避免双 live）。
 * 中继先成则让直连继续跑：晚到的 DC/ws-secure 走现有 track 升级，不重拨。
 */
export async function raceDirectWithRelay<T>(input: {
  nodeId: string;
  direct: Promise<DirectDialResult<T>>;
  relay: Promise<T>;
  abortRelay: () => void;
  onDirectSettled?: (result: DirectDialResult<T>) => void;
}): Promise<T> {
  let directNoted = false;
  const noteDirect = (result: DirectDialResult<T>): DirectDialResult<T> => {
    if (!directNoted) {
      directNoted = true;
      input.onDirectSettled?.(result);
    }
    return result;
  };
  const directP = input.direct.then(
    (result) => ({ kind: 'direct' as const, result: noteDirect(result) }),
    (err: unknown) => {
      noteDirect({ session: null, pending: null });
      throw err;
    }
  );
  const relayP = input.relay.then(
    (session): { kind: 'relay'; session: T; err?: unknown } => ({
      kind: 'relay',
      session,
    }),
    (err: unknown): { kind: 'relay'; session: T | null; err?: unknown } => ({
      kind: 'relay',
      session: null,
      err,
    })
  );

  const first = await Promise.race([directP, relayP]);
  if (first.kind === 'relay') {
    if (first.session) {
      void directP.catch(() => undefined);
      return first.session;
    }
    return takeDirectOrThrow(await directP, first.err, input.nodeId);
  }

  const direct = first.result;
  if (direct.session) {
    input.abortRelay();
    void input.relay.then(
      () => undefined,
      () => undefined
    );
    return direct.session;
  }
  const relay = await relayP;
  if (relay.session) return relay.session;
  return takeDirectOrThrow({ result: direct }, relay.err, input.nodeId);
}

async function takeDirectOrThrow<T>(
  direct: { result: DirectDialResult<T> },
  relayErr: unknown,
  nodeId: string
): Promise<T> {
  if (direct.result.session) return direct.result.session;
  const late = direct.result.pending ? await direct.result.pending : null;
  if (late) return late;
  if (relayErr instanceof NodeUnreachableError) throw relayErr;
  throw new NodeUnreachableError(
    nodeId,
    relayErr instanceof Error ? relayErr.message : 'unreachable'
  );
}

/** 已知中继在线则并行竞速；否则先直连、失败再中继。 */
export async function settleDialWithRelay<T>(input: {
  nodeId: string;
  raceRelay: boolean;
  direct: Promise<DirectDialResult<T>>;
  startRelay: (signal?: AbortSignal) => Promise<T>;
  onDirectSettled: (result: DirectDialResult<T>) => void;
}): Promise<T> {
  if (input.raceRelay) {
    const relayAbort = new AbortController();
    return raceDirectWithRelay({
      nodeId: input.nodeId,
      direct: input.direct,
      relay: input.startRelay(relayAbort.signal),
      abortRelay: () => relayAbort.abort(),
      onDirectSettled: input.onDirectSettled,
    });
  }
  const direct = await input.direct;
  input.onDirectSettled(direct);
  if (direct.session) return direct.session;
  try {
    return await input.startRelay();
  } catch (err) {
    const late = direct.pending ? await direct.pending : null;
    if (late) return late;
    if (err instanceof NodeUnreachableError) throw err;
    throw new NodeUnreachableError(
      input.nodeId,
      err instanceof Error ? err.message : 'unreachable'
    );
  }
}
