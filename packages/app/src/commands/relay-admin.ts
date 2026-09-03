import { t } from '../i18n';
import { loadInstallEnv } from '../lib/local-auth';
import { promptPassword } from '../lib/prompt';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import {
  type RelayIo,
  type RelayQuota,
  asNumber,
  asText,
  confirmRelayAction,
  formatBytes,
  formatQuota,
  formatTable,
  gatewayBaseUrl,
  joinRelayUrl,
  parseBandwidthFlag,
  parseCountFlag,
  printJson,
  quotaFromJson,
  relayAdminToken,
  relayLog,
  requestRelayJson,
  wantsJson,
} from './relay-shared';

const TENANT_ID_RE = /^[0-9a-f]{32}$/;

export type RelayAdminTenant = {
  id: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  nodes: number;
  nodesOnline: number;
  streams: number;
  bytesIn: number;
  bytesOut: number;
  quota: RelayQuota | null;
  tokenEpoch: number;
  kicked: boolean;
};

export type RelayAdminStatus = {
  config: {
    hasPassword: boolean;
    passwordEpoch: number;
    minTokenEpoch: number;
    defaultQuota: RelayQuota | null;
  };
  tenants: RelayAdminTenant[];
  totals: Record<string, unknown>;
  raw: Record<string, unknown>;
};

type AdminCall = {
  baseUrl: string;
  headers: Record<string, string>;
  fetcher?: typeof fetch;
};

async function adminCall(parsed: ParsedArgs, io: RelayIo): Promise<AdminCall> {
  const env = io.env ?? io.auth?.env ?? (await loadInstallEnv(parsed)).env;
  return {
    baseUrl: gatewayBaseUrl(env),
    headers: { authorization: `Bearer ${relayAdminToken(env)}` },
    fetcher: io.fetcher,
  };
}

function tenantFromJson(value: unknown): RelayAdminTenant {
  const raw = (value ?? {}) as Record<string, unknown>;
  const lastSeenAt = raw.lastSeenAt;
  return {
    id: asText(raw.id),
    label: typeof raw.label === 'string' ? raw.label : null,
    createdAt: asNumber(raw.createdAt),
    lastSeenAt: typeof lastSeenAt === 'number' ? lastSeenAt : null,
    nodes: asNumber(raw.nodes),
    nodesOnline: asNumber(raw.nodesOnline),
    streams: asNumber(raw.streams),
    bytesIn: asNumber(raw.bytesIn),
    bytesOut: asNumber(raw.bytesOut),
    quota: quotaFromJson(raw.quota),
    tokenEpoch: asNumber(raw.tokenEpoch),
    kicked: raw.kicked === true,
  };
}

export async function fetchRelayAdminStatus(call: AdminCall): Promise<RelayAdminStatus> {
  const body = await requestRelayJson({
    fetcher: call.fetcher,
    url: joinRelayUrl(call.baseUrl, '/api/relay/status'),
    headers: call.headers,
    label: 'relay status',
  });
  const config = (body.config ?? {}) as Record<string, unknown>;
  const tenants = Array.isArray(body.tenants) ? body.tenants.map(tenantFromJson) : [];
  return {
    config: {
      hasPassword: config.hasPassword === true,
      passwordEpoch: asNumber(config.passwordEpoch),
      minTokenEpoch: asNumber(config.minTokenEpoch),
      defaultQuota: quotaFromJson(config.defaultQuota),
    },
    tenants,
    totals: (body.totals ?? {}) as Record<string, unknown>,
    raw: body,
  };
}

function formatLastSeen(value: number | null): string {
  if (!value) return '-';
  return new Date(value).toISOString().replace('T', ' ').slice(0, 19);
}

export function formatTenantRows(tenants: RelayAdminTenant[]): string[] {
  if (tenants.length === 0) return ['no tenants'];
  const rows = tenants.map((tenant) => [
    tenant.id,
    tenant.label ?? '-',
    `${tenant.nodesOnline}/${tenant.nodes}`,
    String(tenant.streams),
    `${formatBytes(tenant.bytesIn)} / ${formatBytes(tenant.bytesOut)}`,
    formatQuota(tenant.quota),
    String(tenant.tokenEpoch),
    tenant.kicked ? 'kicked' : 'ok',
    formatLastSeen(tenant.lastSeenAt),
  ]);
  return formatTable(
    ['TENANT', 'LABEL', 'ONLINE', 'STREAMS', 'IN / OUT', 'QUOTA', 'EPOCH', 'STATE', 'LAST SEEN'],
    rows
  );
}

export async function runRelayStatus(parsed: ParsedArgs, io: RelayIo = {}): Promise<void> {
  const call = await adminCall(parsed, io);
  const status = await fetchRelayAdminStatus(call);
  if (wantsJson(parsed)) {
    printJson(io, status.raw);
    return;
  }
  relayLog(io, `password: ${status.config.hasPassword ? 'set' : 'not set'}`);
  relayLog(
    io,
    `password epoch: ${status.config.passwordEpoch} (min token epoch ${status.config.minTokenEpoch})`
  );
  relayLog(io, `default quota: ${formatQuota(status.config.defaultQuota)}`);
  relayLog(io, `tenants: ${status.tenants.length}`);
  const online = status.tenants.reduce((sum, tenant) => sum + tenant.nodesOnline, 0);
  const nodes = status.tenants.reduce((sum, tenant) => sum + tenant.nodes, 0);
  relayLog(io, `nodes: ${online} online / ${nodes} known`);
  const bytesIn = status.tenants.reduce((sum, tenant) => sum + tenant.bytesIn, 0);
  const bytesOut = status.tenants.reduce((sum, tenant) => sum + tenant.bytesOut, 0);
  relayLog(io, `traffic: ${formatBytes(bytesIn)} in / ${formatBytes(bytesOut)} out`);
}

export async function runRelayTenants(parsed: ParsedArgs, io: RelayIo = {}): Promise<void> {
  const call = await adminCall(parsed, io);
  const status = await fetchRelayAdminStatus(call);
  if (wantsJson(parsed)) {
    printJson(io, status.raw.tenants ?? []);
    return;
  }
  for (const line of formatTenantRows(status.tenants)) {
    relayLog(io, line);
  }
}

function passwdMode(parsed: ParsedArgs): 'kick' | 'keep' {
  if (parsed.flags.kick === true && parsed.flags.keep === true) {
    throw new Error('relay passwd accepts either --kick or --keep, not both');
  }
  return parsed.flags.kick === true ? 'kick' : 'keep';
}

async function resolveNewRelayPassword(parsed: ParsedArgs, io: RelayIo): Promise<string | null> {
  if (parsed.flags.clear === true) return null;
  if (io.newRelayPassword !== undefined) {
    if (!io.newRelayPassword) throw new Error('relay password cannot be empty');
    return io.newRelayPassword;
  }
  return await promptPassword('New relay password', {
    envKey: 'TMEX_RELAY_PASSWORD',
    confirm: true,
    confirmMessage: 'Confirm new relay password',
  });
}

export async function runRelayPasswd(
  parsed: ParsedArgs,
  io: RelayIo = {}
): Promise<{ mode: 'kick' | 'keep'; cleared: boolean; passwordEpoch: number }> {
  const mode = passwdMode(parsed);
  relayLog(io, t(mode === 'kick' ? 'relay.passwd.modeKick' : 'relay.passwd.modeKeep'));
  const password = await resolveNewRelayPassword(parsed, io);
  const call = await adminCall(parsed, io);
  const body = await requestRelayJson({
    fetcher: call.fetcher,
    url: joinRelayUrl(call.baseUrl, '/api/relay/password'),
    method: 'POST',
    headers: call.headers,
    body: { password, mode },
    label: 'relay passwd',
  });
  const passwordEpoch = asNumber(body.passwordEpoch);
  relayLog(
    io,
    t(password === null ? 'relay.passwd.cleared' : 'relay.passwd.updated', {
      epoch: passwordEpoch,
    })
  );
  return { mode, cleared: password === null, passwordEpoch };
}

function requireTenantId(raw: string | undefined, command: string): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!TENANT_ID_RE.test(value)) {
    throw new Error(`relay ${command} requires <tenantId> (32 hex characters)`);
  }
  return value;
}

export async function runRelayKick(
  parsed: ParsedArgs,
  tenantIdRaw: string,
  io: RelayIo = {}
): Promise<void> {
  const tenantId = requireTenantId(tenantIdRaw, 'kick');
  const call = await adminCall(parsed, io);
  await requestRelayJson({
    fetcher: call.fetcher,
    url: joinRelayUrl(call.baseUrl, `/api/relay/tenants/${tenantId}/kick`),
    method: 'POST',
    headers: call.headers,
    body: {},
    label: 'relay kick',
  });
  relayLog(io, t('relay.kick.done', { tenantId }));
}

export async function runRelayRemove(
  parsed: ParsedArgs,
  tenantIdRaw: string,
  io: RelayIo = {}
): Promise<{ removed: boolean }> {
  const tenantId = requireTenantId(tenantIdRaw, 'remove');
  const confirmed = await confirmRelayAction(io, parsed, t('relay.remove.confirm', { tenantId }));
  if (!confirmed) {
    relayLog(io, t('common.cancelled'));
    return { removed: false };
  }
  const call = await adminCall(parsed, io);
  await requestRelayJson({
    fetcher: call.fetcher,
    url: joinRelayUrl(call.baseUrl, `/api/relay/tenants/${tenantId}`),
    method: 'DELETE',
    headers: call.headers,
    label: 'relay remove',
  });
  relayLog(io, t('relay.remove.done', { tenantId }));
  return { removed: true };
}

export async function runRelayLabel(
  parsed: ParsedArgs,
  rest: string[],
  io: RelayIo = {}
): Promise<void> {
  const tenantId = requireTenantId(rest[0], 'label');
  const text = rest.slice(1).join(' ').trim();
  const call = await adminCall(parsed, io);
  await requestRelayJson({
    fetcher: call.fetcher,
    url: joinRelayUrl(call.baseUrl, `/api/relay/tenants/${tenantId}`),
    method: 'PATCH',
    headers: call.headers,
    body: { label: text || null },
    label: 'relay label',
  });
  relayLog(io, t(text ? 'relay.label.set' : 'relay.label.cleared', { tenantId, label: text }));
}

type QuotaPatch = {
  maxNodes?: number;
  maxStreams?: number;
  bandwidthBytesPerSec?: number | null;
};

export function readQuotaFlags(parsed: ParsedArgs): QuotaPatch {
  const patch: QuotaPatch = {};
  const maxNodes = asString(parsed.flags['max-nodes']);
  if (maxNodes) patch.maxNodes = parseCountFlag(maxNodes, 'max-nodes');
  const maxStreams = asString(parsed.flags['max-streams']);
  if (maxStreams) patch.maxStreams = parseCountFlag(maxStreams, 'max-streams');
  const bandwidth = asString(parsed.flags.bandwidth);
  if (bandwidth) patch.bandwidthBytesPerSec = parseBandwidthFlag(bandwidth);
  return patch;
}

const FALLBACK_QUOTA: RelayQuota = { maxNodes: 8, maxStreams: 32, bandwidthBytesPerSec: null };

export function mergeQuota(base: RelayQuota | null, patch: QuotaPatch): RelayQuota {
  const start = base ?? FALLBACK_QUOTA;
  return {
    maxNodes: patch.maxNodes ?? start.maxNodes,
    maxStreams: patch.maxStreams ?? start.maxStreams,
    bandwidthBytesPerSec:
      patch.bandwidthBytesPerSec === undefined
        ? start.bandwidthBytesPerSec
        : patch.bandwidthBytesPerSec,
  };
}

async function applyDefaultQuota(
  call: AdminCall,
  status: RelayAdminStatus,
  patch: QuotaPatch,
  io: RelayIo
): Promise<RelayQuota> {
  const next = mergeQuota(status.config.defaultQuota, patch);
  await requestRelayJson({
    fetcher: call.fetcher,
    url: joinRelayUrl(call.baseUrl, '/api/relay/config'),
    method: 'PATCH',
    headers: call.headers,
    body: { defaultQuota: next },
    label: 'relay quota',
  });
  relayLog(io, t('relay.quota.default', { quota: formatQuota(next) }));
  return next;
}

async function applyTenantQuota(
  call: AdminCall,
  status: RelayAdminStatus,
  tenantId: string,
  patch: QuotaPatch,
  inherit: boolean,
  io: RelayIo
): Promise<RelayQuota | null> {
  const tenant = status.tenants.find((item) => item.id === tenantId);
  if (!tenant) {
    throw new Error(`unknown tenant: ${tenantId}`);
  }
  const next = inherit ? null : mergeQuota(tenant.quota ?? status.config.defaultQuota, patch);
  await requestRelayJson({
    fetcher: call.fetcher,
    url: joinRelayUrl(call.baseUrl, `/api/relay/tenants/${tenantId}`),
    method: 'PATCH',
    headers: call.headers,
    body: { quota: next },
    label: 'relay quota',
  });
  relayLog(io, t('relay.quota.tenant', { tenantId, quota: formatQuota(next) }));
  return next;
}

export async function runRelayQuota(
  parsed: ParsedArgs,
  targetRaw: string,
  io: RelayIo = {}
): Promise<RelayQuota | null> {
  const target = (targetRaw ?? '').trim().toLowerCase();
  if (!target) {
    throw new Error('relay quota requires <tenantId|default>');
  }
  const inherit = parsed.flags.inherit === true;
  const patch = readQuotaFlags(parsed);
  if (inherit && target === 'default') {
    throw new Error('--inherit applies to a tenant, not the relay default quota');
  }
  if (!inherit && Object.keys(patch).length === 0) {
    throw new Error('relay quota requires --max-nodes / --max-streams / --bandwidth or --inherit');
  }
  const call = await adminCall(parsed, io);
  const status = await fetchRelayAdminStatus(call);
  if (target === 'default') {
    return await applyDefaultQuota(call, status, patch, io);
  }
  return await applyTenantQuota(call, status, requireTenantId(target, 'quota'), patch, inherit, io);
}
