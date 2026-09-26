import { canonicalPublicUrl } from '@vibeterm/shared/auth';
import type { PooledUplink } from './types';
import type { AttachedUplink, UplinkCandidate } from './uplink-pool';

export type UplinkSwitchResult = { ok: true } | { ok: false; reason: string };

export type CombinedAbort = { signal: AbortSignal; cleanup: () => void };

export type UplinkSwitchHost = {
  candidates(): UplinkCandidate[];
  attachedUplink(): AttachedUplink | null;
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
  beginSwitch(): number;
  isSwitchCurrent(token: number): boolean;
  spawn(cand: UplinkCandidate): PooledUplink;
  holdDial(url: string): number;
  releaseDial(serial: number): void;
  releaseSecondary(url: string): Promise<void>;
  takeoverSecondary?(url: string): Promise<PooledUplink | null>;
  notifyTargetFree(): void;
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
};

export async function runUplinkSwitch(
  host: UplinkSwitchHost,
  publicUrl: string,
  signal?: AbortSignal
): Promise<UplinkSwitchResult> {
  const target = host.candidates().find((row) => sameUplinkUrl(row.publicUrl, publicUrl));
  if (!target) return { ok: false, reason: `unknown relay url: ${publicUrl}` };
  if (alreadyAttachedTo(host, publicUrl)) return { ok: true };
  const poolSignal = host.stopSignal();
  if (!poolSignal || poolSignal.aborted) return { ok: false, reason: 'aborted' };
  const held = await holdSwitchTarget(host, publicUrl);
  if (!held) return { ok: false, reason: 'aborted' };
  const taken = (await host.takeoverSecondary?.(publicUrl)) ?? null;
  const combined = signal ? composeAbortSignals(poolSignal, signal) : null;
  const combinedSignal = combined?.signal ?? poolSignal;
  const cands = host.candidates();
  const idx = cands.findIndex((row) => sameUplinkUrl(row.publicUrl, publicUrl));
  host.noteAttempt(target);
  host.logCandidateEvent(target, idx, 'ws', host.lastErrorOf(target), 'try', {
    total: cands.length,
  });
  const token = host.beginSwitch();
  const client = taken ?? host.spawn(target);
  host.pending = client;
  const onAbort = () => invalidateSwitch(host, token, client);
  watchSwitchAbort(signal, onAbort);
  try {
    await connectAndPromote(host, client, target, publicUrl, token, combinedSignal);
    return { ok: true };
  } catch (err) {
    const reason = classifySwitchFailure(host, token, signal, err);
    noteSwitchFailure(host, target, reason, err, idx, 'ws');
    await abandonSwitchClient(host, client);
    host.notifyTargetFree();
    return { ok: false, reason };
  } finally {
    host.releaseDial(held);
    signal?.removeEventListener('abort', onAbort);
    combined?.cleanup();
  }
}

async function holdSwitchTarget(host: UplinkSwitchHost, publicUrl: string): Promise<number | null> {
  const serial = host.holdDial(publicUrl);
  const poolSignal = host.stopSignal();
  if (poolSignal && !poolSignal.aborted) return serial;
  host.releaseDial(serial);
  host.notifyTargetFree();
  return null;
}

function alreadyAttachedTo(host: UplinkSwitchHost, publicUrl: string): boolean {
  const attached = host.attachedUplink();
  return Boolean(
    attached &&
      sameUplinkUrl(attached.publicUrl, publicUrl) &&
      host.liveClient()?.state === 'online'
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
  if (client.state !== 'online') await host.connectCandidate(client, target, combined);
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
  _err: unknown,
  idx: number,
  transport: string
): void {
  if (reason === 'superseded' || reason === 'aborted' || reason === 'stopped') return;
  host.noteFailure(target, reason);
  host.logCandidateFailed(target, reason, 1, idx, transport);
}

function switchAttachedTo(
  host: UplinkSwitchHost,
  client: PooledUplink,
  publicUrl: string
): boolean {
  const live = host.liveClient();
  const attached = host.attachedUplink();
  return Boolean(
    live === client &&
      live.state === 'online' &&
      attached &&
      sameUplinkUrl(attached.publicUrl, publicUrl)
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

function sameUplinkUrl(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    return canonicalPublicUrl(trimmed);
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
