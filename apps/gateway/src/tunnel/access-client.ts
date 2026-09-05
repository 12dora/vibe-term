import { errorMessage } from '@tmex/shared';
import type { TunnelAccessPolicyRule } from '@tmex/shared';
import {
  ACCESS_BYPASS_PATH_PREFIXES,
  TMEX_ALLOW_POLICY_NAME,
  TMEX_APP_NAME,
  TMEX_BYPASS_POLICY_NAME,
  bypassAppDomain,
  bypassAppName,
} from './access-paths';
import { fromCloudflareInclude, toCloudflareInclude } from './access-rules';
import { TunnelError } from './errors';
import { redactSecrets } from './redact';

const CF_API = 'https://api.cloudflare.com/client/v4';
const SESSION_DURATION = '24h';
const AUTHORIZING_DECISIONS = new Set(['allow', 'bypass', 'service_auth']);
export const CF_REQUEST_TIMEOUT_MS = 3_000;
export const CF_MUTATION_TIMEOUT_MS = 15_000;
export const CF_LIST_APPS_DEADLINE_MS = 6_000;

export const ACCESS_TOKEN_PERMISSIONS =
  'Access: Apps and Policies — Edit and Access: Organizations, Identity Providers, and Groups — Read';

export type CloudflareApp = {
  id: string;
  aud: string;
  name: string;
  domain: string;
};

/** listApps 始终带 truncated；无匹配不得当成「未覆盖」。 */
export type CloudflareAppList = CloudflareApp[] & { truncated: boolean };

export type CloudflareAccessClientOptions = {
  requestTimeoutMs?: number;
  mutationTimeoutMs?: number;
  listAppsDeadlineMs?: number;
};

export type CloudflarePolicy = {
  id: string;
  name: string;
  decision: string;
  include: unknown;
};

type CfEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: {
    page?: number;
    per_page?: number;
    count?: number;
    total_count?: number;
    total_pages?: number;
  };
};

export type TunnelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function sanitizeAccessMessage(message: string): string {
  return redactSecrets(message.replace(/\s+/g, ' ').trim()).slice(0, 400);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const value = rec?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function policyLabel(policy: CloudflarePolicy): string {
  return policy.name.trim() || policy.id;
}

export class CloudflareAccessClient {
  constructor(
    private readonly fetchImpl: TunnelFetch = fetch,
    private readonly timeouts: CloudflareAccessClientOptions = {}
  ) {}

  async getOrganization(accountId: string, apiToken: string): Promise<{ teamDomain: string }> {
    let result: Record<string, unknown>;
    try {
      result = await this.request<Record<string, unknown>>(
        'GET',
        `/accounts/${encodeURIComponent(accountId)}/access/organizations`,
        apiToken
      );
    } catch (error) {
      const parsed = error instanceof TunnelError ? error.message : String(error);
      throw new TunnelError(
        'access_api_failed',
        sanitizeAccessMessage(`${parsed}. Token needs ${ACCESS_TOKEN_PERMISSIONS}`)
      );
    }
    const authDomain = readString(result, 'auth_domain');
    if (!authDomain) {
      throw new TunnelError(
        'access_api_failed',
        `Cloudflare Access organization has no team domain. Token needs ${ACCESS_TOKEN_PERMISSIONS}`
      );
    }
    return { teamDomain: authDomain.replace(/^https?:\/\//, '').replace(/\/$/, '') };
  }

  async createApp(
    accountId: string,
    apiToken: string,
    hostname: string,
    opts?: { name?: string; domain?: string }
  ): Promise<CloudflareApp> {
    const result = await this.request<Record<string, unknown>>(
      'POST',
      `/accounts/${encodeURIComponent(accountId)}/access/apps`,
      apiToken,
      {
        type: 'self_hosted',
        name: opts?.name ?? TMEX_APP_NAME,
        domain: opts?.domain ?? hostname,
        session_duration: SESSION_DURATION,
      }
    );
    return this.parseApp(result);
  }

  async updateApp(
    accountId: string,
    apiToken: string,
    appId: string,
    hostname: string,
    opts?: { name?: string; domain?: string }
  ): Promise<CloudflareApp> {
    const result = await this.request<Record<string, unknown>>(
      'PUT',
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}`,
      apiToken,
      {
        type: 'self_hosted',
        name: opts?.name ?? TMEX_APP_NAME,
        domain: opts?.domain ?? hostname,
        session_duration: SESSION_DURATION,
      }
    );
    return this.parseApp(result);
  }

  async getApp(accountId: string, apiToken: string, appId: string): Promise<CloudflareApp> {
    const result = await this.request<Record<string, unknown>>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}`,
      apiToken
    );
    return this.parseApp(result);
  }

  async deleteApp(accountId: string, apiToken: string, appId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}`,
      apiToken,
      undefined,
      { notFoundOk: true }
    );
  }

  async listApps(accountId: string, apiToken: string): Promise<CloudflareAppList> {
    const apps: CloudflareAppList = Object.assign([], { truncated: false });
    const deadlineAt = Date.now() + (this.timeouts.listAppsDeadlineMs ?? CF_LIST_APPS_DEADLINE_MS);
    let page = 1;
    for (;;) {
      if (Date.now() >= deadlineAt) {
        apps.truncated = true;
        break;
      }
      try {
        const { result, result_info } = await this.requestEnvelope<unknown[]>(
          'GET',
          `/accounts/${encodeURIComponent(accountId)}/access/apps?page=${page}&per_page=100`,
          apiToken,
          undefined,
          { deadlineAt }
        );
        const batchLen = this.pushAppBatch(apps, result);
        if (appsPageComplete(page, batchLen, apps.length, result_info)) break;
        page += 1;
        if (page > 50) {
          apps.truncated = true;
          break;
        }
      } catch (error) {
        if (apps.length > 0 && isAbortLike(error)) {
          apps.truncated = true;
          return apps;
        }
        throw error;
      }
    }
    return apps;
  }

  async listPolicies(
    accountId: string,
    apiToken: string,
    appId: string
  ): Promise<CloudflarePolicy[]> {
    const result = await this.request<unknown[]>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies`,
      apiToken
    );
    if (!Array.isArray(result)) return [];
    const policies: CloudflarePolicy[] = [];
    for (const item of result) {
      const rec = asRecord(item);
      const id = readString(rec, 'id');
      if (!id) continue;
      policies.push({
        id,
        name: readString(rec, 'name') ?? '',
        decision: readString(rec, 'decision') ?? '',
        include: rec?.include,
      });
    }
    return policies;
  }

  async replaceAllowPolicy(
    accountId: string,
    apiToken: string,
    appId: string,
    rules: TunnelAccessPolicyRule[]
  ): Promise<void> {
    const include = toCloudflareInclude(rules);
    const body = {
      name: TMEX_ALLOW_POLICY_NAME,
      decision: 'allow',
      include,
    };
    const existing = await this.listPolicies(accountId, apiToken, appId);
    this.assertNoForeignAuthorizingPolicies(existing, TMEX_ALLOW_POLICY_NAME);
    const ours = existing.filter((p) => p.name === TMEX_ALLOW_POLICY_NAME);
    if (ours.length > 1) {
      throw new TunnelError(
        'access_api_failed',
        `Multiple ${TMEX_ALLOW_POLICY_NAME} policies exist (${ours.map(policyLabel).join(', ')}). Remove extras in the Cloudflare dashboard, then retry.`
      );
    }
    const keep = ours[0];
    if (!keep) {
      await this.request(
        'POST',
        `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies`,
        apiToken,
        body
      );
    } else {
      await this.request(
        'PUT',
        `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(keep.id)}`,
        apiToken,
        body
      );
    }
    const verified = await this.listPolicies(accountId, apiToken, appId);
    this.assertNoForeignAuthorizingPolicies(verified, TMEX_ALLOW_POLICY_NAME);
    const allow = verified.find((p) => p.name === TMEX_ALLOW_POLICY_NAME && p.decision === 'allow');
    if (!allow) {
      throw new TunnelError(
        'access_api_failed',
        `Cloudflare Access did not persist the ${TMEX_ALLOW_POLICY_NAME} allow policy`
      );
    }
    const got = fromCloudflareInclude(allow.include);
    if (!rulesMatch(got, rules)) {
      throw new TunnelError(
        'access_api_failed',
        'Cloudflare Access allow policy does not match the requested rules'
      );
    }
  }

  async ensureBypassPolicy(accountId: string, apiToken: string, appId: string): Promise<void> {
    const body = {
      name: TMEX_BYPASS_POLICY_NAME,
      decision: 'bypass',
      include: [{ everyone: {} }],
    };
    const existing = await this.listPolicies(accountId, apiToken, appId);
    this.assertNoForeignAuthorizingPolicies(existing, TMEX_BYPASS_POLICY_NAME);
    const ours = existing.filter((p) => p.name === TMEX_BYPASS_POLICY_NAME);
    if (ours.length > 1) {
      throw new TunnelError(
        'access_api_failed',
        `Multiple ${TMEX_BYPASS_POLICY_NAME} policies exist (${ours.map(policyLabel).join(', ')}). Remove extras in the Cloudflare dashboard, then retry.`
      );
    }
    const keep = ours[0];
    if (!keep) {
      await this.request(
        'POST',
        `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies`,
        apiToken,
        body
      );
    } else {
      await this.request(
        'PUT',
        `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(keep.id)}`,
        apiToken,
        body
      );
    }
  }

  async upsertBypassApps(
    accountId: string,
    apiToken: string,
    hostname: string,
    existingIds: string[]
  ): Promise<string[]> {
    const apps = await this.listApps(accountId, apiToken);
    if (apps.truncated) {
      throw new TunnelError(
        'access_api_failed',
        'Cloudflare Access application list is incomplete'
      );
    }
    const ids: string[] = [];
    for (let i = 0; i < ACCESS_BYPASS_PATH_PREFIXES.length; i++) {
      const prefix = ACCESS_BYPASS_PATH_PREFIXES[i] ?? '/hub/';
      const domain = bypassAppDomain(hostname, prefix);
      const name = bypassAppName(prefix);
      const found =
        apps.find((a) => a.domain.toLowerCase() === domain.toLowerCase()) ??
        (existingIds[i] ? apps.find((a) => a.id === existingIds[i]) : undefined);
      const app = found
        ? await this.updateApp(accountId, apiToken, found.id, hostname, { name, domain })
        : await this.createApp(accountId, apiToken, hostname, { name, domain });
      await this.ensureBypassPolicy(accountId, apiToken, app.id);
      ids.push(app.id);
    }
    return ids;
  }

  async readAppRules(
    accountId: string,
    apiToken: string,
    appId: string
  ): Promise<TunnelAccessPolicyRule[]> {
    const policies = await this.listPolicies(accountId, apiToken, appId);
    const allow =
      policies.find((p) => p.name === TMEX_ALLOW_POLICY_NAME && p.decision === 'allow') ??
      policies.find((p) => p.decision === 'allow');
    return fromCloudflareInclude(allow?.include);
  }

  findAppForHostname(apps: CloudflareApp[], hostname: string): CloudflareApp | null {
    const host = hostname.toLowerCase();
    const exact = apps.find((app) => app.domain.toLowerCase() === host);
    if (exact) return exact;
    return (
      apps.find((app) => app.name === TMEX_APP_NAME && app.domain.toLowerCase() === host) ?? null
    );
  }

  findBypassApps(apps: CloudflareApp[], hostname: string): CloudflareApp[] {
    const host = hostname.toLowerCase();
    const wanted = ACCESS_BYPASS_PATH_PREFIXES.map((p) => bypassAppDomain(host, p).toLowerCase());
    const out: CloudflareApp[] = [];
    for (const domain of wanted) {
      const hit =
        apps.find((a) => a.domain.toLowerCase() === domain) ??
        apps.find((a) => a.name.startsWith('tmex-bypass') && a.domain.toLowerCase() === domain);
      if (hit) out.push(hit);
    }
    return out;
  }

  async getTunnel(
    accountId: string,
    apiToken: string,
    tunnelId: string
  ): Promise<{ id: string; name: string | null }> {
    const result = await this.request<Record<string, unknown>>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
      apiToken
    );
    return {
      id: readString(result, 'id') ?? tunnelId,
      name: readString(result, 'name'),
    };
  }

  async getTunnelIngress(
    accountId: string,
    apiToken: string,
    tunnelId: string
  ): Promise<Array<{ hostname: string | null; service: string }>> {
    const result = await this.request<Record<string, unknown>>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      apiToken
    );
    const config = asRecord(result?.config);
    const ingress = config?.ingress;
    if (!Array.isArray(ingress)) return [];
    const rows: Array<{ hostname: string | null; service: string }> = [];
    for (const item of ingress) {
      const rec = asRecord(item);
      const service = readString(rec, 'service');
      if (!service) continue;
      rows.push({ hostname: readString(rec, 'hostname'), service });
    }
    return rows;
  }

  private assertNoForeignAuthorizingPolicies(
    policies: CloudflarePolicy[],
    managedName: string
  ): void {
    const foreign = policies.filter(
      (p) => p.name !== managedName && AUTHORIZING_DECISIONS.has(p.decision)
    );
    if (!foreign.length) return;
    throw new TunnelError(
      'access_api_failed',
      `Cloudflare Access already has extra allow/bypass/service-auth policies that tmex does not manage: ${foreign.map(policyLabel).join(', ')}. Remove them in the Cloudflare dashboard, then retry.`
    );
  }

  private parseApp(result: Record<string, unknown>): CloudflareApp {
    const id = readString(result, 'id');
    const aud = readString(result, 'aud');
    if (!id || !aud) {
      throw new TunnelError(
        'access_api_failed',
        'Cloudflare Access application response is missing id or aud'
      );
    }
    return {
      id,
      aud,
      name: readString(result, 'name') ?? TMEX_APP_NAME,
      domain: readString(result, 'domain') ?? '',
    };
  }

  private pushAppBatch(apps: CloudflareAppList, result: unknown): number {
    const batch = Array.isArray(result) ? result : [];
    for (const item of batch) {
      try {
        apps.push(this.parseApp(asRecord(item) ?? {}));
      } catch {
        // skip malformed
      }
    }
    return batch.length;
  }

  private requestSignal(deadlineAt?: number, method?: string): AbortSignal {
    const mutation = method === 'POST' || method === 'PUT' || method === 'DELETE';
    // 超时 POST 可能已在远端提交；完整对账不在本轮范围，仅拆读写预算。
    const budget = mutation
      ? (this.timeouts.mutationTimeoutMs ?? CF_MUTATION_TIMEOUT_MS)
      : (this.timeouts.requestTimeoutMs ?? CF_REQUEST_TIMEOUT_MS);
    const remaining = deadlineAt === undefined ? budget : deadlineAt - Date.now();
    return AbortSignal.timeout(Math.max(1, Math.min(budget, remaining)));
  }

  private async request<T>(
    method: string,
    path: string,
    apiToken: string,
    body?: unknown,
    opts?: { notFoundOk?: boolean }
  ): Promise<T> {
    const { result } = await this.requestEnvelope<T>(method, path, apiToken, body, opts);
    return result as T;
  }

  private async requestEnvelope<T>(
    method: string,
    path: string,
    apiToken: string,
    body?: unknown,
    opts?: { notFoundOk?: boolean; deadlineAt?: number }
  ): Promise<CfEnvelope<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${CF_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.requestSignal(opts?.deadlineAt, method),
      });
    } catch (error) {
      const message = errorMessage(error);
      const wrapped = new TunnelError('access_api_failed', sanitizeAccessMessage(message));
      if (isAbortLike(error)) Object.assign(wrapped, { abortLike: true });
      throw wrapped;
    }
    if (res.status === 404 && opts?.notFoundOk) {
      return { success: true, result: undefined as T };
    }
    let envelope: CfEnvelope<T> = {};
    try {
      envelope = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new TunnelError(
        'access_api_failed',
        sanitizeAccessMessage(`Cloudflare API HTTP ${res.status}`)
      );
    }
    if (!res.ok || envelope.success === false) {
      const cfMessage = envelope.errors?.[0]?.message ?? `Cloudflare API HTTP ${res.status}`;
      throw new TunnelError('access_api_failed', sanitizeAccessMessage(cfMessage));
    }
    return envelope;
  }
}

function appsPageComplete(
  page: number,
  batchLen: number,
  appsLen: number,
  info: CfEnvelope<unknown>['result_info']
): boolean {
  const totalPages = info?.total_pages;
  if (typeof totalPages === 'number') return page >= totalPages;
  const total = info?.total_count;
  if (typeof total === 'number') return appsLen >= total;
  return batchLen < 100;
}

function nestedAbort(value: unknown, parent: unknown): boolean {
  return value !== undefined && value !== parent && isAbortLike(value);
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const rec = error as {
    abortLike?: boolean;
    name?: string;
    reason?: unknown;
    cause?: unknown;
    signal?: AbortSignal;
  };
  if (rec.abortLike) return true;
  if (rec.name === 'AbortError' || rec.name === 'TimeoutError') return true;
  if (nestedAbort(rec.reason, error) || nestedAbort(rec.cause, error)) return true;
  if (rec.signal?.aborted) return true;
  if (nestedAbort(rec.signal?.reason, error)) return true;
  const message = errorMessage(error);
  return /aborted|timed?\s*out|timeout/i.test(message);
}

function rulesMatch(got: TunnelAccessPolicyRule[], want: TunnelAccessPolicyRule[]): boolean {
  if (got.length !== want.length) return false;
  const key = (r: TunnelAccessPolicyRule) => `${r.kind}:${r.value}`;
  const a = [...got].map(key).sort();
  const b = [...want].map(key).sort();
  return a.every((v, i) => v === b[i]);
}
