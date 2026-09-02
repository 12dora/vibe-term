import type { CloudflareDnsClient } from './cloudflare-dns';

export type DnsProviderId = 'cloudflare' | 'dnspod';

export type CloudflareDnsCredentials = { token: string };
export type DnspodDnsCredentials = { id: string; token: string };
export type DnsCredentials = CloudflareDnsCredentials | DnspodDnsCredentials;

export type DnsTxtRef = { recordId: string; zone?: string };

export interface DnsProvider {
  readonly id: DnsProviderId;
  createTxt(creds: DnsCredentials, fqdn: string, value: string): Promise<DnsTxtRef>;
  deleteTxt(creds: DnsCredentials, ref: DnsTxtRef): Promise<void>;
  getNameServers?(creds: DnsCredentials, zone: string): Promise<string[]>;
}

export const DNS_PROVIDER_IDS = ['cloudflare', 'dnspod'] as const;

export function asDnsProviderId(value: unknown): DnsProviderId | null {
  return typeof value === 'string' && (DNS_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as DnsProviderId)
    : null;
}

export function isDnspodCredentials(creds: DnsCredentials): creds is DnspodDnsCredentials {
  return 'id' in creds;
}

export function normalizeDnsCredentials(
  provider: DnsProviderId,
  value: unknown
): DnsCredentials | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const token = typeof rec.token === 'string' ? rec.token.trim() : '';
  if (provider === 'cloudflare') {
    return token ? { token } : null;
  }
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  return id && token ? { id, token } : null;
}

export function parseDnsSecret(raw: string, provider: DnsProviderId): DnsCredentials | null {
  try {
    return normalizeDnsCredentials(provider, JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function serializeDnsCredentials(creds: DnsCredentials): string {
  return isDnspodCredentials(creds)
    ? JSON.stringify({ id: creds.id, token: creds.token })
    : JSON.stringify({ token: creds.token });
}

export function inferDnsProviderFromSecret(raw: string): DnsProviderId | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.id === 'string' && rec.id.trim() && typeof rec.token === 'string') {
      return 'dnspod';
    }
    if (typeof rec.token === 'string' && rec.token.trim()) return 'cloudflare';
    return null;
  } catch {
    return null;
  }
}

export function resolveStoredDnsCredentials(
  row: { acmeDnsProvider?: string | null },
  secrets: { acmeDnsSecret?: string | null; acmeCfToken?: string | null }
): { provider: DnsProviderId | null; credentials: DnsCredentials | null } {
  const fromSecret = secrets.acmeDnsSecret
    ? inferDnsProviderFromSecret(secrets.acmeDnsSecret)
    : null;
  const provider =
    asDnsProviderId(row.acmeDnsProvider) ??
    fromSecret ??
    (secrets.acmeCfToken ? 'cloudflare' : null);

  if (secrets.acmeDnsSecret && provider) {
    const parsed = parseDnsSecret(secrets.acmeDnsSecret, provider);
    if (parsed) return { provider, credentials: parsed };
  }
  if (secrets.acmeCfToken && (provider === 'cloudflare' || provider === null)) {
    return { provider: 'cloudflare', credentials: { token: secrets.acmeCfToken } };
  }
  return { provider, credentials: null };
}

function cloudflareToken(creds: DnsCredentials): string {
  if (isDnspodCredentials(creds) || !creds.token) {
    throw new Error('cloudflare dns-01 requires { token }');
  }
  return creds.token;
}

export class CloudflareDnsProvider implements DnsProvider {
  readonly id = 'cloudflare' as const;

  constructor(private readonly client: CloudflareDnsClient) {}

  async createTxt(creds: DnsCredentials, fqdn: string, value: string): Promise<DnsTxtRef> {
    const token = cloudflareToken(creds);
    const zoneHint = fqdn.replace(/^_acme-challenge\./i, '');
    const zone = await this.client.findZoneId(token, zoneHint);
    const recordId = await this.client.createTxt(token, zone, fqdn, value);
    return { recordId, zone };
  }

  async deleteTxt(creds: DnsCredentials, ref: DnsTxtRef): Promise<void> {
    if (!ref.zone) throw new Error('cloudflare TXT delete requires zone');
    await this.client.deleteRecord(cloudflareToken(creds), ref.zone, ref.recordId);
  }

  async getNameServers(creds: DnsCredentials, zone: string): Promise<string[]> {
    return this.client.getNameServers(cloudflareToken(creds), zone);
  }
}
