import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import type { UserStore } from '../auth/user-store';
import { logLine } from './mesh-log';
import { handshakeRelay } from './peer-protocol';
import type { RelayPresenceIndex, RelayStreamOpener } from './relay-presence-types';
import { type MeshIdentity, NodeUnreachableError } from './types';

const RETRYABLE_RELAY_RST = new Set(['offline', 'unknown-target']);

export function isRetryableRelayOpenReason(reason: string | null | undefined): boolean {
  return Boolean(reason && RETRYABLE_RELAY_RST.has(reason));
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

async function openVia(
  opener: RelayStreamOpener,
  url: string,
  nodeId: string
): Promise<LinkStream> {
  const stream = await opener.openRelayVia(url, nodeId);
  const reason = await rstReasonOf(stream);
  if (isRetryableRelayOpenReason(reason)) {
    throw new Error(reason ?? 'offline');
  }
  return stream;
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
}): Promise<{ stream: LinkStream; viaRelay?: string }> {
  const { nodeId, presence, opener, openFallback } = input;
  if (!presence || !opener) return { stream: await openFallback(nodeId) };
  const choice = presence.chooseRelay(nodeId);
  if (!choice) return { stream: await openFallback(nodeId) };
  logLine(
    '[mesh][peer]',
    formatRelayChooseLog(nodeId, choice.url, choice.scoreMs, presence.relaysFor(nodeId).length)
  );
  try {
    return { stream: await openVia(opener, choice.url, nodeId), viaRelay: choice.url };
  } catch (err) {
    const primary = presence.primaryUrl();
    const reason = relayOpenFailureReason(err);
    if (!isRetryableRelayOpenReason(reason) || !primary || primary === choice.url) throw err;
    return { stream: await openVia(opener, primary, nodeId), viaRelay: primary };
  }
}

async function handshakeWithPrimaryRetry(
  opened: { stream: LinkStream; viaRelay?: string },
  nodeId: string,
  identity: MeshIdentity,
  userStore: UserStore,
  presence: RelayPresenceIndex | undefined,
  opener: RelayStreamOpener | undefined
): Promise<{ result: Awaited<ReturnType<typeof handshakeRelay>>; viaRelay?: string }> {
  const handshake = (stream: LinkStream) =>
    handshakeRelay({ stream, role: 'initiator', identity, userStore });
  try {
    return { result: await handshake(opened.stream), viaRelay: opened.viaRelay };
  } catch (err) {
    const reason = relayOpenFailureReason(err) ?? (await rstReasonOf(opened.stream));
    const primary = presence?.primaryUrl() ?? null;
    if (
      !isRetryableRelayOpenReason(reason) ||
      !opener ||
      !primary ||
      !opened.viaRelay ||
      primary === opened.viaRelay
    ) {
      throw err;
    }
    quietReset(opened.stream, 'relay-retry-primary');
    const stream = await openVia(opener, primary, nodeId);
    return { result: await handshake(stream), viaRelay: primary };
  }
}

export async function completeRelayDial(input: {
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
}): Promise<LinkSession> {
  const opened = await openRelayStreamForPeer({
    nodeId: input.nodeId,
    presence: input.presence,
    opener: input.opener,
    openFallback: input.openFallback,
  });
  const { result, viaRelay } = await handshakeWithPrimaryRetry(
    opened,
    input.nodeId,
    input.identity,
    input.userStore,
    input.presence,
    input.opener
  );
  if (result.peerNodeId !== input.nodeId) {
    result.session.close('peer-id-mismatch');
    throw new NodeUnreachableError(input.nodeId, 'relay peer id mismatch');
  }
  input.rememberKeys(result.session, result.sendKey, result.recvKey);
  const kept = input.track(result.session, result.peerNodeId, input.gen);
  if (!kept) throw new NodeUnreachableError(input.nodeId, 'simultaneous-dial');
  if (viaRelay) {
    const live = input.liveOf(result.peerNodeId);
    if (live?.transport === 'relay') live.viaRelay = viaRelay;
  }
  return kept;
}
