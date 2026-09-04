import { canonicalHubUrl } from '@tmex/shared/auth';
import type { PooledUplink } from './types';
import type { AttachedHub, UplinkCandidate } from './uplink-pool';

export type UplinkSwitchHost = {
  candidates(): UplinkCandidate[];
  attachedHub(): AttachedHub | null;
  liveClient(): PooledUplink | null;
  stopSignal(): AbortSignal | null;
  pending: PooledUplink | null;
  noteAttempt(cand: UplinkCandidate): void;
  logCandidateEvent(
    cand: UplinkCandidate,
    idx: number,
    transport: string,
    error: string | null,
    kind: 'try' | 'failover' | 'switch-back' | 'failed',
    extra?: { fails?: number; total?: number }
  ): void;
  lastErrorOf(cand: UplinkCandidate): string | null;
  isLocalTransport(cand: UplinkCandidate): boolean;
  beginSwitch(): number;
  isSwitchCurrent(token: number): boolean;
  spawn(cand: UplinkCandidate): PooledUplink;
  connectCandidate(client: PooledUplink, cand: UplinkCandidate, signal: AbortSignal): Promise<void>;
  promote(client: PooledUplink, cand: UplinkCandidate, token: number): Promise<void>;
  noteFailure(cand: Pick<UplinkCandidate, 'publicUrl'>, msg: string): void;
  logCandidateFailed(
    cand: UplinkCandidate,
    msg: string,
    fails: number,
    idx: number,
    transport: string
  ): void;
  logMissingCaPin(cand: UplinkCandidate, err: unknown): void;
};

export async function runUplinkSwitch(
  host: UplinkSwitchHost,
  publicUrl: string,
  signal?: AbortSignal
): Promise<void> {
  const target = host.candidates().find((row) => sameHubUrl(row.publicUrl, publicUrl));
  if (!target) throw new Error(`unknown hub url: ${publicUrl}`);
  if (alreadyAttachedTo(host, publicUrl)) return;
  const poolSignal = host.stopSignal();
  if (!poolSignal || poolSignal.aborted) throw new Error('aborted');
  const combined = signal ? anyAbort(poolSignal, signal) : poolSignal;
  const cands = host.candidates();
  const idx = cands.findIndex((row) => sameHubUrl(row.publicUrl, publicUrl));
  const transport = host.isLocalTransport(target) ? 'memory' : 'ws';
  host.noteAttempt(target);
  host.logCandidateEvent(target, idx, transport, host.lastErrorOf(target), 'try', {
    total: cands.length,
  });
  const token = host.beginSwitch();
  const client = host.spawn(target);
  host.pending = client;
  const onAbort = () => invalidateSwitch(host, token, client);
  watchSwitchAbort(signal, onAbort);
  try {
    await connectAndPromote(host, client, target, publicUrl, token, signal, combined);
  } catch (err) {
    noteSwitchFailure(host, target, err, idx, transport);
    await abandonSwitchClient(host, client);
    throw err instanceof Error ? err : new Error(errMessage(err));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function alreadyAttachedTo(host: UplinkSwitchHost, publicUrl: string): boolean {
  const attached = host.attachedHub();
  return Boolean(
    attached && sameHubUrl(attached.publicUrl, publicUrl) && host.liveClient()?.state === 'online'
  );
}

function watchSwitchAbort(signal: AbortSignal | undefined, onAbort: () => void): void {
  if (!signal) return;
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
}

function invalidateSwitch(host: UplinkSwitchHost, token: number, client: PooledUplink): void {
  if (host.isSwitchCurrent(token)) host.beginSwitch();
  if (host.pending === client) host.pending = null;
  if (host.liveClient() !== client) void client.stop();
}

async function connectAndPromote(
  host: UplinkSwitchHost,
  client: PooledUplink,
  target: UplinkCandidate,
  publicUrl: string,
  token: number,
  signal: AbortSignal | undefined,
  combined: AbortSignal
): Promise<void> {
  if (combined.aborted) throw new Error(switchAbortReason(signal, combined));
  await host.connectCandidate(client, target, combined);
  if (!host.isSwitchCurrent(token) || combined.aborted) {
    throw new Error(switchAbortReason(signal, combined));
  }
  await host.promote(client, target, token);
  if (!switchAttachedTo(host, client, publicUrl)) throw new Error('superseded');
}

function noteSwitchFailure(
  host: UplinkSwitchHost,
  target: UplinkCandidate,
  err: unknown,
  idx: number,
  transport: string
): void {
  const msg = errMessage(err);
  if (msg === 'superseded' || msg === 'aborted' || msg === 'stopped') return;
  host.noteFailure(target, msg);
  host.logCandidateFailed(target, msg, 1, idx, transport);
  host.logMissingCaPin(target, err);
}

function switchAbortReason(callSignal: AbortSignal | undefined, combined: AbortSignal): string {
  if (callSignal?.aborted) return 'connect-timeout';
  if (combined.aborted) return 'aborted';
  return 'superseded';
}

function switchAttachedTo(
  host: UplinkSwitchHost,
  client: PooledUplink,
  publicUrl: string
): boolean {
  const live = host.liveClient();
  const attached = host.attachedHub();
  return Boolean(
    live === client &&
      live.state === 'online' &&
      attached &&
      sameHubUrl(attached.publicUrl, publicUrl)
  );
}

async function abandonSwitchClient(host: UplinkSwitchHost, client: PooledUplink): Promise<void> {
  if (host.pending === client) host.pending = null;
  if (host.liveClient() === client) return;
  try {
    await client.stop();
  } catch {
    /* ignore */
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameHubUrl(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    return canonicalHubUrl(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function anyAbort(a: AbortSignal, b: AbortSignal): AbortSignal {
  const out = new AbortController();
  const abort = () => {
    if (!out.signal.aborted) out.abort();
  };
  if (a.aborted || b.aborted) {
    abort();
    return out.signal;
  }
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return out.signal;
}

export function terminalErrorOf(client: PooledUplink): string | null {
  const reason = client.lastConnectError?.reason?.trim() ?? '';
  if (!reason || /^(stopped|aborted)$/i.test(reason)) return null;
  return reason;
}
