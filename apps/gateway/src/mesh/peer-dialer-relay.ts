import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import type { UserStore } from '../auth/user-store';
import { handshakeRelay } from './peer-protocol';
import {
  type RelayDialBreaker,
  classifyRelayDialFailure,
  getRelayDialBreaker,
  logRelayBreakerCooling,
} from './relay-dial-breaker';
import type { RelayPresenceIndex, RelayStreamOpener } from './relay-presence-types';
import { type MeshIdentity, NodeUnreachableError } from './types';

const RETRYABLE_RELAY_RST = new Set(['offline', 'unknown-target']);

/** 握手完成前的失败：换下一条中继，不当作对端的错。 */
const PRE_HANDSHAKE_RST = new Set([
  'offline',
  'unknown-target',
  'uplink-retiring',
  'relay-unhandled',
  'stale',
  'unauthenticated',
  'quota-streams',
  'open-failed',
  'relay-open-local',
]);

/** 开流抛错里仍要记到对端熔断上的 RST。其余连接错误换成 relay-open-local，不计 peer。 */
const COUNTED_OPEN_THROW = new Set(['offline', 'unknown-target']);

export function isRetryableRelayOpenReason(reason: string | null | undefined): boolean {
  return Boolean(reason && RETRYABLE_RELAY_RST.has(reason));
}

export function isPreHandshakeRelayFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!msg) return false;
  if (msg === 'uplink is not online') return true;
  return PRE_HANDSHAKE_RST.has(msg);
}

export function relayOpenFailureReason(err: unknown): string | null {
  if (typeof err === 'string') return RETRYABLE_RELAY_RST.has(err) ? err : null;
  if (!(err instanceof Error)) return null;
  if (RETRYABLE_RELAY_RST.has(err.message)) return err.message;
  return null;
}

export async function rstReasonOf(stream: LinkStream): Promise<string | null> {
  const closed = await Promise.race([stream.closed, Promise.resolve(undefined)]);
  if (!closed || closed.reason !== 'rst') return null;
  return closed.message ?? null;
}

function quietReset(stream: LinkStream, reason: string): void {
  try {
    stream.reset(reason);
  } catch {
    // already closed
  }
}

function quietClose(session: { close(reason?: string): void }, reason: string): void {
  try {
    session.close(reason);
  } catch {
    // already closed
  }
}

async function openVia(
  opener: RelayStreamOpener,
  url: string,
  nodeId: string
): Promise<LinkStream> {
  const stream = await openRelayOrSkip(opener, url, nodeId);
  const reason = await rstReasonOf(stream);
  if (reason && PRE_HANDSHAKE_RST.has(reason)) throw new Error(reason);
  return stream;
}

async function openRelayOrSkip(
  opener: RelayStreamOpener,
  url: string,
  nodeId: string
): Promise<LinkStream> {
  try {
    return await opener.openRelayVia(url, nodeId);
  } catch (err) {
    if (preserveOpenThrow(err)) throw err;
    throw new Error('relay-open-local');
  }
}

function preserveOpenThrow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!msg) return false;
  if (msg === 'uplink is not online') return true;
  return PRE_HANDSHAKE_RST.has(msg) || COUNTED_OPEN_THROW.has(msg);
}

export function formatRelayChooseLog(
  nodeId: string,
  via: string,
  scoreMs: number | null,
  candidates: number
): string {
  return `relay choose peer=${nodeId} via=${via} score_ms=${scoreMs ?? '-'} candidates=${candidates}`;
}

export async function openRelayStreamForPeer(input: {
  nodeId: string;
  presence?: RelayPresenceIndex;
  opener?: RelayStreamOpener;
  openFallback: (nodeId: string) => Promise<LinkStream>;
  breaker?: RelayDialBreaker;
  exclude?: readonly string[];
}): Promise<{ stream: LinkStream; viaRelay?: string }> {
  const { nodeId, presence, opener, openFallback } = input;
  if (!presence || !opener) return { stream: await openFallback(nodeId) };
  const opened = await openChosenRelay(input, presence, opener);
  if (opened) return opened;
  return { stream: await openFallback(nodeId) };
}

async function openChosenRelay(
  input: {
    nodeId: string;
    breaker?: RelayDialBreaker;
    exclude?: readonly string[];
  },
  presence: RelayPresenceIndex,
  opener: RelayStreamOpener
): Promise<{ stream: LinkStream; viaRelay?: string } | null> {
  const tried = [...(input.exclude ?? [])];
  const breaker = input.breaker ?? getRelayDialBreaker();
  let last: unknown = null;
  for (let i = 0; i < 8; i += 1) {
    const url = nextRelayUrl(presence, input.nodeId, tried);
    if (!url) {
      if (last) throw last;
      return null;
    }
    tried.push(url);
    const choice = presence.chooseRelay(input.nodeId, { exclude: tried.slice(0, -1) });
    if (choice && choice.url === url) {
      breaker.logChoose(input.nodeId, url, choice.scoreMs, presence.relaysFor(input.nodeId).length);
    }
    try {
      return { stream: await openVia(opener, url, input.nodeId), viaRelay: url };
    } catch (err) {
      last = err;
      if (!isPreHandshakeRelayFailure(err)) throw err;
    }
  }
  if (last && !isPreHandshakeRelayFailure(last)) throw last;
  return null;
}

function nextRelayUrl(
  presence: RelayPresenceIndex,
  nodeId: string,
  tried: readonly string[]
): string | null {
  const choice = presence.chooseRelay(nodeId, { exclude: tried });
  if (choice && !alreadyTried(tried, choice.url)) return choice.url;
  if (tried.length === 0) return null;
  const primary = presence.primaryUrl();
  if (!primary || alreadyTried(tried, primary)) return null;
  return primary;
}

function alreadyTried(tried: readonly string[], url: string): boolean {
  return tried.some((item) => item === url);
}

async function handshakeWithPrimaryRetry(
  opened: { stream: LinkStream; viaRelay?: string; timeoutMs?: number },
  nodeId: string,
  identity: MeshIdentity,
  userStore: UserStore,
  presence: RelayPresenceIndex | undefined,
  opener: RelayStreamOpener | undefined
): Promise<{ result: Awaited<ReturnType<typeof handshakeRelay>>; viaRelay?: string }> {
  const handshake = (stream: LinkStream) =>
    handshakeRelay({
      stream,
      role: 'initiator',
      identity,
      userStore,
      timeoutMs: opened.timeoutMs,
    });
  try {
    return { result: await handshake(opened.stream), viaRelay: opened.viaRelay };
  } catch (err) {
    const reason = relayOpenFailureReason(err) ?? (await rstReasonOf(opened.stream));
    if (!canRetryHandshake(reason, err, opener, opened.viaRelay)) throw err;
    quietReset(opened.stream, 'relay-retry-primary');
    const next = await openRelayStreamForPeer({
      nodeId,
      presence,
      opener,
      openFallback: async () => {
        throw err;
      },
      exclude: opened.viaRelay ? [opened.viaRelay] : [],
    });
    return { result: await handshake(next.stream), viaRelay: next.viaRelay };
  }
}

function canRetryHandshake(
  reason: string | null,
  err: unknown,
  opener: RelayStreamOpener | undefined,
  viaRelay: string | undefined
): boolean {
  if (!opener || !viaRelay) return false;
  if (reason && PRE_HANDSHAKE_RST.has(reason)) return true;
  return isPreHandshakeRelayFailure(err);
}

function throwIfRelayAborted(signal: AbortSignal | undefined, nodeId: string): void {
  if (!signal?.aborted) return;
  throw new NodeUnreachableError(nodeId, 'aborted');
}

async function awaitUnlessAborted<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  nodeId: string,
  onLate: (value: T) => void
): Promise<T> {
  if (!signal) return pending;
  throwIfRelayAborted(signal, nodeId);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void pending.then(onLate, () => undefined);
      reject(new NodeUnreachableError(nodeId, 'aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          onLate(value);
          reject(new NodeUnreachableError(nodeId, 'aborted'));
          return;
        }
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

export type PeerRelayDialHost = {
  identity: MeshIdentity;
  userStore: UserStore;
  relayPresence?: RelayPresenceIndex;
  relayOpener?: RelayStreamOpener;
  uplink: { openRelay(nodeId: string): Promise<LinkStream> };
  live: { get(nodeId: string): { transport: string; viaRelay?: string } | undefined };
  relayBreaker?: RelayDialBreaker;
};

export function openPeerRelaySession(input: {
  host: PeerRelayDialHost;
  nodeId: string;
  gen: number;
  rememberKeys: (session: LinkSession, sendKey?: Uint8Array, recvKey?: Uint8Array) => void;
  track: (session: LinkSession, peerNodeId: string, gen: number) => LinkSession | null;
  signal?: AbortSignal;
  background?: boolean;
}): Promise<LinkSession> {
  const { host } = input;
  return completeRelayDial({
    nodeId: input.nodeId,
    gen: input.gen,
    identity: host.identity,
    userStore: host.userStore,
    presence: host.relayPresence,
    opener: host.relayOpener,
    openFallback: (id) => host.uplink.openRelay(id),
    rememberKeys: input.rememberKeys,
    track: input.track,
    liveOf: (peerNodeId) => host.live.get(peerNodeId),
    signal: input.signal,
    breaker: host.relayBreaker,
    bypassBreaker: input.background === true,
  });
}

export type CompleteRelayDialInput = {
  nodeId: string;
  gen: number;
  identity: MeshIdentity;
  userStore: UserStore;
  presence?: RelayPresenceIndex;
  opener?: RelayStreamOpener;
  openFallback: (nodeId: string) => Promise<LinkStream>;
  rememberKeys: (session: LinkSession, sendKey?: Uint8Array, recvKey?: Uint8Array) => void;
  track: (session: LinkSession, peerNodeId: string, gen: number) => LinkSession | null;
  liveOf: (peerNodeId: string) => { transport: string; viaRelay?: string } | undefined;
  signal?: AbortSignal;
  breaker?: RelayDialBreaker;
  handshakeTimeoutMs?: number;
  /** 降级 / 借路等后台拨号不进前台熔断，也不跟前台抢单飞。 */
  bypassBreaker?: boolean;
};

export async function completeRelayDial(input: CompleteRelayDialInput): Promise<LinkSession> {
  throwIfRelayAborted(input.signal, input.nodeId);
  const breaker = input.breaker ?? getRelayDialBreaker();
  if (input.bypassBreaker) return executeRelayDial(input, breaker);
  return breaker.singleFlight(input.nodeId, () => runGuardedRelayDial(input, breaker));
}

async function runGuardedRelayDial(
  input: CompleteRelayDialInput,
  breaker: RelayDialBreaker
): Promise<LinkSession> {
  const decision = breaker.shouldTry(input.nodeId);
  if (!decision.allow) {
    logRelayBreakerCooling(input.nodeId, decision.until);
    throw new NodeUnreachableError(input.nodeId, 'breaker_cooling');
  }
  breaker.beginAttempt(input.nodeId);
  try {
    const kept = await executeRelayDial(input, breaker);
    breaker.noteSuccess(input.nodeId);
    return kept;
  } catch (err) {
    const kind = classifyRelayDialFailure(err);
    breaker.noteFailure(input.nodeId, kind);
    throw err;
  }
}

async function executeRelayDial(
  input: CompleteRelayDialInput,
  breaker: RelayDialBreaker
): Promise<LinkSession> {
  const opened = await awaitUnlessAborted(
    openRelayStreamForPeer({
      nodeId: input.nodeId,
      presence: input.presence,
      opener: input.opener,
      openFallback: input.openFallback,
      breaker,
    }),
    input.signal,
    input.nodeId,
    (late) => quietReset(late.stream, 'dial-race-lost')
  );
  const handshake = await handshakeOpened(input, opened);
  return finishRelayHandshake(input, handshake);
}

async function handshakeOpened(
  input: CompleteRelayDialInput,
  opened: { stream: LinkStream; viaRelay?: string }
): Promise<Awaited<ReturnType<typeof handshakeWithPrimaryRetry>>> {
  try {
    return await awaitUnlessAborted(
      handshakeWithPrimaryRetry(
        { ...opened, timeoutMs: input.handshakeTimeoutMs },
        input.nodeId,
        input.identity,
        input.userStore,
        input.presence,
        input.opener
      ),
      input.signal,
      input.nodeId,
      (late) => quietClose(late.result.session, 'dial-race-lost')
    );
  } catch (err) {
    if (input.signal?.aborted) quietReset(opened.stream, 'dial-race-lost');
    throw err;
  }
}

function finishRelayHandshake(
  input: CompleteRelayDialInput,
  handshake: Awaited<ReturnType<typeof handshakeWithPrimaryRetry>>
): LinkSession {
  const { result, viaRelay } = handshake;
  if (input.signal?.aborted) {
    quietClose(result.session, 'dial-race-lost');
    throw new NodeUnreachableError(input.nodeId, 'aborted');
  }
  if (result.peerNodeId !== input.nodeId) {
    result.session.close('peer-id-mismatch');
    throw new NodeUnreachableError(input.nodeId, 'relay peer id mismatch');
  }
  input.rememberKeys(result.session, result.sendKey, result.recvKey);
  const kept = input.track(result.session, result.peerNodeId, input.gen);
  if (!kept) throw new NodeUnreachableError(input.nodeId, 'simultaneous-dial');
  if (viaRelay && kept === result.session) {
    const live = input.liveOf(result.peerNodeId);
    if (live?.transport === 'relay') live.viaRelay = viaRelay;
  }
  return kept;
}
