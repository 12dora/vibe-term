import type { TunnelAccessPolicyRule } from '@tmex/shared';
import { fromCloudflareInclude, toCloudflareInclude } from './access-rules';
import { TunnelError } from './errors';
import { redactSecrets } from './redact';

const CF_API = 'https://api.cloudflare.com/client/v4';
const APP_NAME = 'tmex';
const POLICY_NAME = 'tmex-allow';
const SESSION_DURATION = '24h';

export type CloudflareApp = {
  id: string;
  aud: string;
  name: string;
  domain: string;
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

export class CloudflareAccessClient {
  constructor(private readonly fetchImpl: TunnelFetch = fetch) {}

  async getOrganization(accountId: string, apiToken: string): Promise<{ teamDomain: string }> {
    const result = await this.request<Record<string, unknown>>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/access/organizations`,
      apiToken
    );
    const authDomain = readString(result, 'auth_domain');
    if (!authDomain) {
      throw new TunnelError(
        'access_api_failed',
        'Cloudflare Access organization has no team domain'
      );
    }
    return { teamDomain: authDomain.replace(/^https?:\/\//, '').replace(/\/$/, '') };
  }

  async createApp(accountId: string, apiToken: string, hostname: string): Promise<CloudflareApp> {
    const result = await this.request<Record<string, unknown>>(
      'POST',
      `/accounts/${encodeURIComponent(accountId)}/access/apps`,
      apiToken,
      {
        type: 'self_hosted',
        name: APP_NAME,
        domain: hostname,
        session_duration: SESSION_DURATION,
      }
    );
    return this.parseApp(result);
  }

  async updateApp(
    accountId: string,
    apiToken: string,
    appId: string,
    hostname: string
  ): Promise<CloudflareApp> {
    const result = await this.request<Record<string, unknown>>(
      'PUT',
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}`,
      apiToken,
      {
        type: 'self_hosted',
        name: APP_NAME,
        domain: hostname,
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
      apiToken
    );
  }

  async listApps(accountId: string, apiToken: string): Promise<CloudflareApp[]> {
    const apps: CloudflareApp[] = [];
    let page = 1;
    for (;;) {
      const { result, result_info } = await this.requestEnvelope<unknown[]>(
        'GET',
        `/accounts/${encodeURIComponent(accountId)}/access/apps?page=${page}&per_page=100`,
        apiToken
      );
      const batch = Array.isArray(result) ? result : [];
      for (const item of batch) {
        try {
          apps.push(this.parseApp(asRecord(item) ?? {}));
        } catch {
          // skip malformed
        }
      }
      const total = result_info?.total_count;
      const totalPages = result_info?.total_pages;
      if (typeof totalPages === 'number') {
        if (page >= totalPages) break;
      } else if (typeof total === 'number') {
        if (apps.length >= total) break;
      } else if (batch.length < 100) {
        break;
      }
      page += 1;
      if (page > 50) break;
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
      name: POLICY_NAME,
      decision: 'allow',
      include,
    };
    const existing = await this.listPolicies(accountId, apiToken, appId);
    const keep = existing[0];
    if (!keep) {
      await this.request(
        'POST',
        `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies`,
        apiToken,
        body
      );
      return;
    }
    await this.request(
      'PUT',
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(keep.id)}`,
      apiToken,
      body
    );
    for (const extra of existing.slice(1)) {
      await this.request(
        'DELETE',
        `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(extra.id)}`,
        apiToken
      ).catch(() => {});
    }
  }

  async readAppRules(
    accountId: string,
    apiToken: string,
    appId: string
  ): Promise<TunnelAccessPolicyRule[]> {
    const policies = await this.listPolicies(accountId, apiToken, appId);
    const allow = policies.find((p) => p.decision === 'allow') ?? policies[0];
    return fromCloudflareInclude(allow?.include);
  }

  findAppForHostname(apps: CloudflareApp[], hostname: string): CloudflareApp | null {
    const host = hostname.toLowerCase();
    for (const app of apps) {
      const domain = app.domain.toLowerCase();
      if (domain === host || domain.startsWith(`${host}/`)) return app;
    }
    return null;
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
      name: readString(result, 'name') ?? APP_NAME,
      domain: readString(result, 'domain') ?? '',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    apiToken: string,
    body?: unknown
  ): Promise<T> {
    const { result } = await this.requestEnvelope<T>(method, path, apiToken, body);
    return result as T;
  }

  private async requestEnvelope<T>(
    method: string,
    path: string,
    apiToken: string,
    body?: unknown
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TunnelError('access_api_failed', sanitizeAccessMessage(message));
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
