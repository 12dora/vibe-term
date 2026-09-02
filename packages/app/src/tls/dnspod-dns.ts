import { getBaseVersion } from '../../../../apps/gateway/src/system/version';
import type { DnsCredentials, DnsProvider, DnsTxtRef, DnspodDnsCredentials } from './dns-provider';
import { isDnspodCredentials } from './dns-provider';

const API_BASE = 'https://dnsapi.cn';

export type DnspodDnsFetch = (input: string, init?: RequestInit) => Promise<Response>;

type DnspodStatus = { code?: string | number; message?: string };
type DomainInfo = {
  id?: string | number;
  name?: string;
  punycode?: string;
  dnspod_ns?: string[];
};
type DnspodPayload = {
  status?: DnspodStatus;
  domain?: DomainInfo;
  domains?: DomainInfo[];
  record?: { id?: string | number };
};

export type DnspodDnsClientOptions = {
  fetch?: DnspodDnsFetch;
  email?: string;
  version?: string;
};

function asDnspod(creds: DnsCredentials): DnspodDnsCredentials {
  if (!isDnspodCredentials(creds) || !creds.id.trim() || !creds.token.trim()) {
    throw new Error('dnspod dns-01 requires { id, token }');
  }
  return creds;
}

function ok(payload: DnspodPayload): boolean {
  return String(payload.status?.code ?? '') === '1';
}

function statusDetail(payload: DnspodPayload, fallback: string): string {
  const message = payload.status?.message?.trim();
  const code = payload.status?.code;
  if (message && code !== undefined) return `${code}: ${message}`;
  return message || fallback;
}

function labelsOf(domain: string): string[] {
  return domain.replace(/\.$/, '').split('.').filter(Boolean);
}

function zoneCandidates(domain: string): string[] {
  const labels = labelsOf(domain);
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i += 1) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

function subDomain(fqdn: string, zone: string): string {
  const host = fqdn.replace(/\.$/, '').toLowerCase();
  const apex = zone.replace(/\.$/, '').toLowerCase();
  if (host === apex) return '@';
  if (host.endsWith(`.${apex}`)) return host.slice(0, -(apex.length + 1));
  throw new Error(`dnspod fqdn ${fqdn} is not under zone ${zone}`);
}

export class DnspodDnsClient implements DnsProvider {
  readonly id = 'dnspod' as const;
  private readonly fetchImpl: DnspodDnsFetch;
  private readonly email: string;
  private readonly version: string;

  constructor(opts: DnspodDnsClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.email = opts.email?.trim() || 'acme@localhost';
    this.version = opts.version?.trim() || getBaseVersion();
  }

  async createTxt(creds: DnsCredentials, fqdn: string, value: string): Promise<DnsTxtRef> {
    const token = asDnspod(creds);
    const zone = await this.findZone(token, fqdn);
    const payload = await this.request(token, 'Record.Create', {
      domain: zone,
      sub_domain: subDomain(fqdn, zone),
      record_type: 'TXT',
      record_line_id: '0',
      record_line: '默认',
      value,
      ttl: '600',
    });
    const recordId = payload.record?.id;
    if (recordId === undefined || recordId === null || String(recordId) === '') {
      throw new Error('dnspod TXT create returned no record id');
    }
    return { recordId: String(recordId), zone };
  }

  async deleteTxt(creds: DnsCredentials, ref: DnsTxtRef): Promise<void> {
    if (!ref.zone) throw new Error('dnspod TXT delete requires zone');
    await this.request(asDnspod(creds), 'Record.Remove', {
      domain: ref.zone,
      record_id: ref.recordId,
    });
  }

  async getNameServers(creds: DnsCredentials, zone: string): Promise<string[]> {
    const payload = await this.request(asDnspod(creds), 'Domain.Info', { domain: zone });
    return (payload.domain?.dnspod_ns ?? []).filter(
      (item): item is string => typeof item === 'string' && item.length > 0
    );
  }

  private async findZone(creds: DnspodDnsCredentials, fqdn: string): Promise<string> {
    const candidates = zoneCandidates(fqdn);
    for (const candidate of candidates) {
      try {
        const payload = await this.request(creds, 'Domain.Info', { domain: candidate });
        const name = payload.domain?.name || payload.domain?.punycode || candidate;
        if (name) return name;
      } catch {
        // not this suffix; try a shorter one
      }
    }
    const listed = await this.request(creds, 'Domain.List', {});
    const owned = new Set(
      (listed.domains ?? [])
        .flatMap((item) => [item.name, item.punycode])
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .map((item) => item.replace(/\.$/, '').toLowerCase())
    );
    for (const candidate of candidates) {
      if (owned.has(candidate.toLowerCase())) return candidate;
    }
    throw new Error(`dnspod zone not found for ${fqdn}`);
  }

  private async request(
    creds: DnspodDnsCredentials,
    method: string,
    fields: Record<string, string>
  ): Promise<DnspodPayload> {
    const body = new URLSearchParams({
      login_token: `${creds.id},${creds.token}`,
      format: 'json',
      lang: 'en',
      ...fields,
    });
    const res = await this.fetchImpl(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': `tmex/${this.version} (${this.email})`,
      },
      body,
    });
    let payload: DnspodPayload;
    try {
      payload = (await res.json()) as DnspodPayload;
    } catch {
      throw new Error(`dnspod API ${method} returned non-JSON (${res.status})`);
    }
    if (!res.ok || !ok(payload)) {
      throw new Error(statusDetail(payload, `dnspod API ${method} failed (${res.status})`));
    }
    return payload;
  }
}
