import { canonicalHubUrl } from '@tmex/shared/auth';
import type { PooledUplink } from './types';
import type { AttachedHub, UplinkCandidate } from './uplink-pool';

export type UplinkSwitchResult = { ok: true } | { ok: false; reason: string };

export type CombinedAbort = { signal: AbortSignal; cleanup: () => void };

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
): Promise<UplinkSwitchResult> {
  const target = host.candidates().find((row) => sameHubUrl(row.publicUrl, publicUrl));
  if (!target) return { ok: false, reason: `unknown hub url: ${publicUrl}` };
  if (alreadyAttachedTo(host, publicUrl)) return { ok: true };
  const poolSignal = host.stopSignal();
  if (!poolSignal || poolSignal.aborted) return { ok: false, reason: 'aborted' };
  const combined = signal ? composeAbortSignals(poolSignal, signal) : null;
  const combinedSignal = combined?.signal ?? poolSignal;
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
    await connectAndPromote(host, client, target, publicUrl, token, combinedSignal);
    return { ok: true };
  } catch (err) {
    const reason = classifySwitchFailure(host, token, signal, err);
    noteSwitchFailure(host, target, reason, err, idx, transport);
    await abandonSwitchClient(host, client);
    return { ok: false, reason };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    combined?.cleanup();
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
  if (host.liveClient() === client) return;
  if (host.isSwitchCurrent(token)) host.beginSwitch();
  if (host.pending === client) host.pending = null;
  void client.stop();
}

async function connectAndPromote(
  host: UplinkSwitchHost,
  client: PooledUplink,
  target: UplinkCandidate,
  publicUrl: string,
  token: number,
  combined: AbortSignal
): Promise<void> {
  if (combined.aborted || !host.isSwitchCurrent(token)) throw new Error('aborted');
  await host.connectCandidate(client, target, combined);
  if (!host.isSwitchCurrent(token) || combined.aborted) throw new Error('aborted');
  await host.promote(client, target, token);
  if (!switchAttachedTo(host, client, publicUrl)) throw new Error('superseded');
}

export function classifySwitchFailure(
  host: Pick<UplinkSwitchHost, 'stopSignal' | 'isSwitchCurrent'>,
  token: number,
  callSignal: AbortSignal | undefined,
  err: unknown
): string {
  if (callSignal?.aborted) return 'connect-timeout';
  const stop = host.stopSignal();
  if (!stop || stop.aborted) return 'aborted';
  if (!host.isSwitchCurrent(token)) return 'superseded';
  return errMessage(err);
}

function noteSwitchFailure(
  host: UplinkSwitchHost,
  target: UplinkCandidate,
  reason: string,
  err: unknown,
  idx: number,
  transport: string
): void {
  if (reason === 'superseded' || reason === 'aborted' || reason === 'stopped') return;
  host.noteFailure(target, reason);
  host.logCandidateFailed(target, reason, 1, idx, transport);
  host.logMissingCaPin(target, err);
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

export function composeAbortSignals(a: AbortSignal, b: AbortSignal): CombinedAbort {
  const out = new AbortController();
  let cleaned = false;
  const onAbort = () => {
    cleanup();
    if (!out.signal.aborted) out.abort();
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    a.removeEventListener('abort', onAbort);
    b.removeEventListener('abort', onAbort);
  };
  if (a.aborted || b.aborted) {
    out.abort();
    return { signal: out.signal, cleanup };
  }
  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);
  return { signal: out.signal, cleanup };
}

export function terminalErrorOf(client: PooledUplink): string | null {
  const reason = client.lastConnectError?.reason?.trim() ?? '';
  if (!reason || /^(stopped|aborted)$/i.test(reason)) return null;
  return reason;
}
