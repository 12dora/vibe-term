import type { RelayAutoSelectView, RelaySwitchReason } from '@vibeterm/shared/relay';
import { readJsonObjectBody } from '../api/http';
import { classifyRelayLinkError } from './relay-link-error';
import type { RelayPresence } from './relay-presence';
import { normalizeUrlOrNull } from './relay-routes-input';
import type { RelaySecrets } from './relay-secrets';
import type { RelayStatusCandidate } from './relay-status-row';
import type { RelayUplinkClient } from './relay-uplink-client';
import { jsonBody, jsonError } from './session-middleware';
import type { PooledUplink } from './types';
import { type AttachedHub, sameHubUrl } from './uplink-pool';
import type { UplinkSwitchResult } from './uplink-pool-switch';

export const RELAY_SWITCH_TIMEOUT_MS = 10_000;

export type RelayUplinkView = {
  liveClient(): PooledUplink | null;
  attachedHub(): AttachedHub | null;
  reconfigure(): Promise<void>;
  candidates(): RelayStatusCandidate[];
  switchTo(url: string, signal?: AbortSignal): Promise<UplinkSwitchResult>;
  secondaryClient?(url: string): RelayUplinkClient | null;
  presence?(): RelayPresence | null;
  prepareSwitch?(url: string): Promise<void>;
  multiAttach?(): boolean;
  autoSelectView?(): RelayAutoSelectView | null;
  scoreOf?(url: string): number | null;
  noteSwitchReason?(reason: RelaySwitchReason | null): void;
  /** 进程内首选：自动切换写入、手动 pin 覆盖、unpin 留当前主中继。 */
  noteAutoPreferred?(url: string | null): void;
};

export type RelaySwitchDeps = {
  secrets: RelaySecrets;
  uplink: RelayUplinkView;
  switchTimeoutMs?: number;
};

export type RelaySwitchOpts = {
  persistPin?: boolean;
};

type SwitchFailure = { ok: false; lastError: string; lastErrorCode: string };

export async function handleRelaySwitch(
  deps: RelaySwitchDeps,
  req: Request,
  status: () => Promise<Response>
): Promise<Response> {
  const body = await readJsonObjectBody(req);
  const url = normalizeUrlOrNull(body?.url);
  if (!url) return jsonError('INVALID_URL', 400);
  const row = deps.secrets.relayRows().find((entry) => sameHubUrl(entry.url, url));
  if (!row) return jsonError('RELAY_UNKNOWN', 404);
  if (row.kicked) return jsonError('RELAY_KICKED', 409);
  const attached = deps.uplink.attachedHub();
  const live = deps.uplink.liveClient();
  if (attached && sameHubUrl(attached.publicUrl, url) && live?.state === 'online') {
    return jsonError('RELAY_ALREADY_ATTACHED', 409);
  }
  const switched = await runRelaySwitch(deps, url, { persistPin: true });
  if (!switched.ok) {
    return jsonError('RELAY_SWITCH_FAILED', 502, {
      lastError: switched.lastError,
      lastErrorCode: switched.lastErrorCode,
    });
  }
  return status();
}

export function handleRelayUnpin(deps: RelaySwitchDeps): Response {
  const unpinned = Boolean(deps.secrets.preferredRelayUrl());
  try {
    deps.secrets.clearPreferredRelayUrl();
  } catch {
    /* 未固定时也当成功 */
  }
  // unpin 后把当前主中继留在 autoPreferred，避免候选序回到 priority 0 被探测拽走
  deps.uplink.noteAutoPreferred?.(deps.uplink.attachedHub()?.publicUrl ?? null);
  return jsonBody({ ok: true, unpinned });
}

export async function runRelaySwitch(
  deps: RelaySwitchDeps,
  url: string,
  opts?: RelaySwitchOpts
): Promise<{ ok: true } | SwitchFailure> {
  const persistPin = opts?.persistPin !== false;
  await deps.uplink.prepareSwitch?.(url);
  deps.uplink.noteSwitchReason?.(persistPin ? 'manual' : 'auto-rtt');
  const ac = new AbortController();
  const timeoutMs = deps.switchTimeoutMs ?? RELAY_SWITCH_TIMEOUT_MS;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const result = await deps.uplink.switchTo(url, ac.signal);
    if (!result.ok) {
      deps.uplink.noteSwitchReason?.(null);
      return switchFailed(new Error(result.reason));
    }
    if (persistPin) persistPreferred(deps, url);
    deps.uplink.noteAutoPreferred?.(url);
    return { ok: true };
  } catch (err) {
    deps.uplink.noteSwitchReason?.(null);
    if (ac.signal.aborted) return switchFailed(new Error('connect-timeout'));
    return switchFailed(err);
  } finally {
    clearTimeout(timer);
  }
}

function persistPreferred(deps: RelaySwitchDeps, url: string): void {
  try {
    deps.secrets.setPreferredRelayUrl(url);
  } catch {
    /* 首选只影响下次启动顺序，切换本身已经成功 */
  }
}

function switchFailed(err: unknown): SwitchFailure {
  const lastError = err instanceof Error && err.message ? err.message : 'connect-failed';
  return {
    ok: false,
    lastError,
    lastErrorCode: classifyRelayLinkError(lastError) ?? 'unknown',
  };
}
