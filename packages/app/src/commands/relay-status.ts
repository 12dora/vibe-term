import {
  type RelayStatusResponse,
  type RelayTenantSession,
  fetchRelayStatus,
  fetchRelayStatusLocal,
  openRelayTenantSession,
  relayGatewayRequest,
} from '../lib/relay-session';
import type { ParsedArgs } from '../types';
import {
  RelayApiError,
  type RelayIo,
  formatTable,
  gatewayBaseUrl,
  joinRelayUrl,
  printJson,
  relayLog,
  requestRelayJson,
  wantsJson,
} from './relay-shared';
import { withAuth } from './with-auth';

function formatRelayRole(role: RelayStatusResponse['relays'][number]['role']): string {
  return role === 'primary' || role === 'secondary' ? role : '-';
}

type TurnMembersTally = { ok: number; total: number };

function turnMembersTally(value: unknown): TurnMembersTally | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { ok?: unknown; total?: unknown };
  if (typeof raw.ok !== 'number' || typeof raw.total !== 'number') return null;
  if (!Number.isFinite(raw.ok) || !Number.isFinite(raw.total) || raw.ok < 0 || raw.total < 0) {
    return null;
  }
  return { ok: Math.floor(raw.ok), total: Math.floor(raw.total) };
}

function rawRelayRow(status: RelayStatusResponse, url: string): Record<string, unknown> | null {
  const raw = Array.isArray(status.raw.relays) ? status.raw.relays : [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (row.url === url) return row;
  }
  return null;
}

function turnMembersOf(status: RelayStatusResponse, url: string): TurnMembersTally | null {
  const turn = rawRelayRow(status, url)?.turn;
  if (!turn || typeof turn !== 'object') return null;
  return turnMembersTally((turn as { members?: unknown }).members);
}

function formatRelayTurn(
  turn: { url: string; probeOk: boolean | null } | null | undefined,
  members?: TurnMembersTally | null
): string {
  if (!turn?.url) return '-';
  const frac = members ? `${members.ok}/${members.total}` : null;
  if (turn.probeOk === false) {
    return frac ? `${turn.url} (down, ${frac} nodes ok)` : `${turn.url} (down)`;
  }
  if (turn.probeOk === true && frac) return `${turn.url} (ok, ${frac})`;
  return turn.url;
}

function pathBestMsOf(status: RelayStatusResponse, url: string): number | undefined {
  const value = rawRelayRow(status, url)?.pathBestMs;
  return typeof value === 'number' ? value : undefined;
}

function hasAutoSelectPayload(status: RelayStatusResponse): boolean {
  const view = status.raw.autoSelect;
  return Boolean(view && typeof view === 'object');
}

function preferredUrlOf(status: RelayStatusResponse): string | null {
  const value = status.raw.preferredUrl;
  return typeof value === 'string' && value ? value : null;
}

export function formatAutoCell(row: Record<string, unknown> | null | undefined): string {
  if (row?.pinned === true) return 'pinned';
  if (row?.autoSelected === true) return 'auto';
  return '-';
}

function formatScoreCell(row: Record<string, unknown> | null | undefined): string {
  return typeof row?.score === 'number' && Number.isFinite(row.score) ? String(row.score) : '-';
}

function relayStatusHeaders(showAuto: boolean, showBest: boolean): string[] {
  const headers = ['PRI', 'URL', 'ROLE'];
  if (showAuto) headers.push('AUTO');
  headers.push('STATE', 'RTT');
  if (showBest) headers.push('BEST');
  if (showAuto) headers.push('SCORE');
  headers.push('PEERS', 'TURN', 'NOTE');
  return headers;
}

export function formatRelayStatusLines(status: RelayStatusResponse): string[] {
  const lines = [`mode: ${status.mode}`];
  if (status.tenantId) lines.push(`tenant: ${status.tenantId}`);
  lines.push(`meta epoch: ${status.metaEpoch}`);
  lines.push(`peers via relay: ${status.nodesViaRelay}`);
  if (status.multiAttach) lines.push('multi-attach: yes');
  if (status.reauthRequired) lines.push('reauth required: run vibeterm relay reauth <url>');
  if (status.relays.length === 0) {
    lines.push('no relays configured');
    return lines;
  }
  const showAuto = hasAutoSelectPayload(status) || preferredUrlOf(status) != null;
  const showBest = status.relays.some((relay) => pathBestMsOf(status, relay.url) != null);
  const rows = status.relays.map((relay) => {
    const raw = rawRelayRow(status, relay.url);
    const cells = [String(relay.priority), relay.url, formatRelayRole(relay.role)];
    if (showAuto) cells.push(formatAutoCell(raw));
    cells.push(
      relay.online ? 'online' : 'offline',
      relay.rttMs == null ? '-' : `${relay.rttMs} ms`
    );
    if (showBest) {
      const best = pathBestMsOf(status, relay.url);
      cells.push(best == null ? '-' : `${best} ms`);
    }
    if (showAuto) cells.push(formatScoreCell(raw));
    cells.push(
      relay.peersOnline == null ? '-' : String(relay.peersOnline),
      formatRelayTurn(relay.turn, turnMembersOf(status, relay.url)),
      relay.kicked ? 'kicked' : (relay.lastError ?? '-')
    );
    return cells;
  });
  lines.push(...formatTable(relayStatusHeaders(showAuto, showBest), rows));
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

function printUnpinResult(parsed: ParsedArgs, io: RelayIo, body: Record<string, unknown>): void {
  if (wantsJson(parsed)) {
    printJson(io, body);
    return;
  }
  relayLog(io, nothingWasPinned(body) ? 'nothing pinned' : 'unpinned');
}

function nothingWasPinned(body: Record<string, unknown>): boolean {
  return body.unpinned === false;
}

async function postRelayUnpin(input: {
  baseUrl: string;
  fetcher?: RelayIo['fetcher'];
}): Promise<Record<string, unknown>> {
  try {
    return await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(input.baseUrl, '/api/mesh/relay/unpin'),
      method: 'POST',
      body: {},
      label: 'relay unpin',
    });
  } catch (error) {
    if (error instanceof RelayApiError && error.status === 404) {
      return { ok: true, unpinned: false };
    }
    throw error;
  }
}

async function unpinViaSession(session: RelayTenantSession): Promise<Record<string, unknown>> {
  try {
    return await relayGatewayRequest(session, {
      path: '/api/mesh/relay/unpin',
      method: 'POST',
      body: {},
      label: 'relay unpin',
    });
  } catch (error) {
    if (error instanceof RelayApiError && error.status === 404) {
      return { ok: true, unpinned: false };
    }
    throw error;
  }
}

async function executeRelayUnpin(
  parsed: ParsedArgs,
  io: RelayIo,
  getStatus: () => Promise<RelayStatusResponse>,
  postUnpin: () => Promise<Record<string, unknown>>
): Promise<void> {
  const status = await getStatus();
  if (!preferredUrlOf(status)) {
    printUnpinResult(parsed, io, { ok: true, unpinned: false });
    return;
  }
  const body = await postUnpin();
  printUnpinResult(parsed, io, { ok: true, unpinned: body.unpinned !== false });
}

export async function runRelayUnpin(parsed: ParsedArgs, io: RelayIo = {}): Promise<void> {
  const env = io.env ?? process.env;
  const baseUrl = gatewayBaseUrl(env);
  try {
    await executeRelayUnpin(
      parsed,
      io,
      () => fetchRelayStatusLocal({ baseUrl, fetcher: io.fetcher }),
      () => postRelayUnpin({ baseUrl, fetcher: io.fetcher })
    );
    return;
  } catch (error) {
    if (!(error instanceof RelayApiError) || error.status !== 401) throw error;
  }
  await withAuth(parsed, io, async (ctx) => {
    const session = await openRelayTenantSession(parsed, ctx, io);
    await executeRelayUnpin(
      parsed,
      io,
      () => fetchRelayStatus(session),
      () => unpinViaSession(session)
    );
  });
}
