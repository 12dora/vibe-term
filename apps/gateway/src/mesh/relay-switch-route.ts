import { readJsonObjectBody } from '../api/http';
import { classifyRelayLinkError } from './relay-link-error';
import { normalizeUrlOrNull } from './relay-routes-input';
import type { RelaySecrets } from './relay-secrets';
import type { RelayStatusCandidate } from './relay-status-row';
import { jsonError } from './session-middleware';
import type { PooledUplink } from './types';
import { type AttachedHub, sameHubUrl } from './uplink-pool';

export const RELAY_SWITCH_TIMEOUT_MS = 10_000;

export type RelayUplinkView = {
  liveClient(): PooledUplink | null;
  attachedHub(): AttachedHub | null;
  reconfigure(): Promise<void>;
  candidates(): RelayStatusCandidate[];
  switchTo(url: string, signal?: AbortSignal): Promise<void>;
};

export type RelaySwitchDeps = {
  secrets: RelaySecrets;
  uplink: RelayUplinkView;
  switchTimeoutMs?: number;
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
  const switched = await runRelaySwitch(deps, url);
  if (!switched.ok) {
    return jsonError('RELAY_SWITCH_FAILED', 502, {
      lastError: switched.lastError,
      lastErrorCode: switched.lastErrorCode,
    });
  }
  try {
    deps.secrets.setPreferredRelayUrl(url);
  } catch {
    /* 首选只影响下次启动顺序，切换本身已经成功 */
  }
  return status();
}

async function runRelaySwitch(
  deps: RelaySwitchDeps,
  url: string
): Promise<{ ok: true } | SwitchFailure> {
  const ac = new AbortController();
  const timeoutMs = deps.switchTimeoutMs ?? RELAY_SWITCH_TIMEOUT_MS;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await deps.uplink.switchTo(url, ac.signal);
    if (ac.signal.aborted) return switchFailed(new Error('connect-timeout'));
    if (!switchAttachedOnline(deps.uplink, url)) {
      return switchFailed(new Error('superseded'));
    }
    return { ok: true };
  } catch (err) {
    if (ac.signal.aborted) return switchFailed(new Error('connect-timeout'));
    return switchFailed(err);
  } finally {
    clearTimeout(timer);
  }
}

function switchAttachedOnline(uplink: RelayUplinkView, url: string): boolean {
  const attached = uplink.attachedHub();
  const live = uplink.liveClient();
  return Boolean(attached && sameHubUrl(attached.publicUrl, url) && live?.state === 'online');
}

function switchFailed(err: unknown): SwitchFailure {
  const lastError = err instanceof Error && err.message ? err.message : 'connect-failed';
  return {
    ok: false,
    lastError,
    lastErrorCode: classifyRelayLinkError(lastError) ?? 'unknown',
  };
}
