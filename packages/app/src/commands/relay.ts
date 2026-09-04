import { decodeBase64url, encodeBase64url } from '../../../shared/src/auth';
import { normalizeRelayUrl, signRelayEnrollProof } from '../../../shared/src/relay';
import { t } from '../i18n';
import { promptPassword } from '../lib/prompt';
import {
  type RelayStatusResponse,
  type RelayTenantSession,
  fetchRelayStatus,
  fetchRelayStatusLocal,
  openRelayTenantSession,
  pollRelayStatus,
  relayGatewayRequest,
  signAndSubmitRelayRecord,
} from '../lib/relay-session';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import {
  RelayApiError,
  type RelayIo,
  asNumber,
  asText,
  formatTable,
  gatewayBaseUrl,
  joinRelayUrl,
  printJson,
  relayLog,
  requestRelayJson,
  wantsJson,
} from './relay-shared';
import { withAuth } from './with-auth';

export type RelayHealth = {
  ok: boolean;
  version: string;
  tenants: number;
  nodesOnline: number;
  uptimeMs: number;
  hasPassword: boolean | null;
};

export function parseRelayHealth(body: Record<string, unknown>): RelayHealth {
  const hasPassword = body.hasPassword;
  return {
    ok: body.ok === true,
    version: asText(body.version),
    tenants: asNumber(body.tenants),
    nodesOnline: asNumber(body.nodesOnline),
    uptimeMs: asNumber(body.uptimeMs),
    hasPassword: typeof hasPassword === 'boolean' ? hasPassword : null,
  };
}

function requireRelayUrl(raw: string, command: string): string {
  if (!raw) {
    throw new Error(`relay ${command} requires <url>`);
  }
  return normalizeRelayUrl(raw);
}

async function fetchRelayHealth(relayUrl: string, io: RelayIo): Promise<RelayHealth> {
  const body = await requestRelayJson({
    fetcher: io.fetcher,
    url: joinRelayUrl(relayUrl, '/api/relay/health'),
    label: 'relay health',
  });
  return parseRelayHealth(body);
}

async function resolveRelayPassword(
  parsed: ParsedArgs,
  io: RelayIo,
  health: RelayHealth
): Promise<string | undefined> {
  const flag = asString(parsed.flags.password);
  if (flag) return flag;
  if (io.relayPassword !== undefined) return io.relayPassword || undefined;
  if (health.hasPassword === false) return undefined;
  if (health.hasPassword === null) return undefined;
  return await promptPassword('Relay password', {
    envKey: 'TMEX_RELAY_PASSWORD',
    confirm: false,
  });
}

function setRelaysPayload(body: Record<string, unknown>): Uint8Array {
  const raw = body.set_relays ?? body.payload;
  if (typeof raw !== 'string' || !raw) {
    throw new Error('relay enroll returned no set-relays payload');
  }
  return decodeBase64url(raw);
}

type EnrollExchange = {
  tenantId: string;
  token: string;
  payload: Uint8Array;
};

async function exchangeRelayEnroll(
  session: RelayTenantSession,
  input: { relayUrl: string; password: string | undefined }
): Promise<EnrollExchange> {
  const material = await relayGatewayRequest(session, {
    path: '/api/mesh/relay/enroll/proof-material',
    method: 'POST',
    body: { url: input.relayUrl },
    label: 'relay proof material',
  });
  const relayHost = asText(material.relayHost) || asText(material.relay_host);
  const ts = asNumber(material.ts, Date.now());
  if (!relayHost) {
    throw new Error('relay proof material returned no relay host');
  }
  const proof = signRelayEnrollProof(session.rootKey, { relayHost, ts });
  const body = await relayGatewayRequest(session, {
    path: '/api/mesh/relay/enroll',
    method: 'POST',
    body: {
      url: input.relayUrl,
      ...(input.password === undefined ? {} : { password: input.password }),
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
      ts,
    },
    label: 'relay enroll',
  });
  return {
    tenantId: asText(body.tenantId) || asText(body.tenant_id),
    token: asText(body.token),
    payload: setRelaysPayload(body),
  };
}

function isPasswordRejection(error: unknown): boolean {
  return (
    error instanceof RelayApiError &&
    (error.status === 401 || error.code === 'RELAY_PASSWORD_INVALID')
  );
}

async function enrollWithRetry(
  session: RelayTenantSession,
  input: { relayUrl: string; password: string | undefined; io: RelayIo }
): Promise<EnrollExchange> {
  try {
    return await exchangeRelayEnroll(session, {
      relayUrl: input.relayUrl,
      password: input.password,
    });
  } catch (error) {
    if (input.password !== undefined || !isPasswordRejection(error)) throw error;
    relayLog(input.io, t('relay.enroll.passwordRequired'));
    const password = await promptPassword('Relay password', {
      envKey: 'TMEX_RELAY_PASSWORD',
      confirm: false,
    });
    return await exchangeRelayEnroll(session, { relayUrl: input.relayUrl, password });
  }
}

function reportRelayStatus(io: RelayIo, relayUrl: string, status: RelayStatusResponse): void {
  const row = status.relays.find((item) => item.url === relayUrl);
  if (status.mode === 'relay' && row?.online) {
    relayLog(io, t('relay.enroll.done', { url: relayUrl, tenantId: status.tenantId ?? '' }));
    return;
  }
  relayLog(io, t('relay.enroll.pending', { url: relayUrl, error: row?.lastError ?? '' }));
}

async function runRelayEnrollInternal(
  parsed: ParsedArgs,
  urlRaw: string,
  io: RelayIo,
  command: 'enroll' | 'reauth'
): Promise<{ tenantId: string; relayUrl: string; online: boolean }> {
  const relayUrl = requireRelayUrl(urlRaw, command);
  const health = await fetchRelayHealth(relayUrl, io);
  if (!health.ok) {
    throw new Error(`relay is not healthy: ${relayUrl}`);
  }
  const password = await resolveRelayPassword(parsed, io, health);

  return await withAuth(parsed, io, async (ctx) => {
    const session = await openRelayTenantSession(parsed, ctx, io);
    const exchange = await enrollWithRetry(session, { relayUrl, password, io });
    await signAndSubmitRelayRecord(session, {
      type: 'set-relays',
      payload: exchange.payload,
      // 并发追加时重新问节点要一份 payload：中继表/节点集合可能已经变了。
      rebuild: async () => (await exchangeRelayEnroll(session, { relayUrl, password })).payload,
    });
    const status = await pollRelayStatus(
      session,
      io,
      (current) =>
        current.mode === 'relay' &&
        current.relays.some((item) => item.url === relayUrl && item.online)
    );
    reportRelayStatus(io, relayUrl, status);
    const row = status.relays.find((item) => item.url === relayUrl);
    return {
      tenantId: exchange.tenantId || (status.tenantId ?? ''),
      relayUrl,
      online: Boolean(row?.online),
    };
  });
}

export async function runRelayEnroll(
  parsed: ParsedArgs,
  urlRaw: string,
  io: RelayIo = {}
): Promise<{ tenantId: string; relayUrl: string; online: boolean }> {
  return await runRelayEnrollInternal(parsed, urlRaw, io, 'enroll');
}

export async function runRelayReauth(
  parsed: ParsedArgs,
  urlRaw: string,
  io: RelayIo = {}
): Promise<{ tenantId: string; relayUrl: string; online: boolean }> {
  return await runRelayEnrollInternal(parsed, urlRaw, io, 'reauth');
}

export async function runRelayLeave(
  parsed: ParsedArgs,
  io: RelayIo = {}
): Promise<{ mode: RelayStatusResponse['mode'] }> {
  return await withAuth(parsed, io, async (ctx) => {
    const session = await openRelayTenantSession(parsed, ctx, io);
    const prepared = await relayGatewayRequest(session, {
      path: '/api/mesh/relay/leave/prepare',
      method: 'POST',
      body: {},
      label: 'relay leave',
    });
    const leavePayload = async (): Promise<Uint8Array> =>
      setRelaysPayload(
        await relayGatewayRequest(session, {
          path: '/api/mesh/relay/leave/prepare',
          method: 'POST',
          body: {},
          label: 'relay leave',
        })
      );
    await signAndSubmitRelayRecord(session, {
      type: 'set-relays',
      payload: setRelaysPayload(prepared),
      rebuild: leavePayload,
    });
    const status = await pollRelayStatus(session, io, (current) => current.mode !== 'relay');
    relayLog(io, t(status.mode === 'relay' ? 'relay.leave.pending' : 'relay.leave.done'));
    return { mode: status.mode };
  });
}

export function formatRelayStatusLines(status: RelayStatusResponse): string[] {
  const lines = [`mode: ${status.mode}`];
  if (status.tenantId) lines.push(`tenant: ${status.tenantId}`);
  lines.push(`meta epoch: ${status.metaEpoch}`);
  lines.push(`peers via relay: ${status.nodesViaRelay}`);
  if (status.reauthRequired) lines.push('reauth required: run tmex relay reauth <url>');
  if (status.relays.length === 0) {
    lines.push('no relays configured');
    return lines;
  }
  const rows = status.relays.map((relay) => [
    String(relay.priority),
    relay.url,
    relay.online ? 'online' : 'offline',
    relay.attached ? 'attached' : '-',
    relay.rttMs == null ? '-' : `${relay.rttMs} ms`,
    relay.kicked ? 'kicked' : (relay.lastError ?? '-'),
  ]);
  lines.push(...formatTable(['PRI', 'URL', 'STATE', 'ATTACHED', 'RTT', 'NOTE'], rows));
  return lines;
}

export async function runRelayList(parsed: ParsedArgs, io: RelayIo = {}): Promise<void> {
  const env = io.env ?? process.env;
  try {
    const status = await fetchRelayStatusLocal({
      baseUrl: gatewayBaseUrl(env),
      fetcher: io.fetcher,
    });
    printRelayList(parsed, io, status);
    return;
  } catch (error) {
    if (!(error instanceof RelayApiError) || error.status !== 401) throw error;
  }
  await withAuth(parsed, io, async (ctx) => {
    const session = await openRelayTenantSession(parsed, ctx, io);
    printRelayList(parsed, io, await fetchRelayStatus(session));
  });
}

function printRelayList(parsed: ParsedArgs, io: RelayIo, status: RelayStatusResponse): void {
  if (wantsJson(parsed)) {
    printJson(io, status.raw);
    return;
  }
  for (const line of formatRelayStatusLines(status)) {
    relayLog(io, line);
  }
}
