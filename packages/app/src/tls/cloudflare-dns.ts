const API_BASE = 'https://api.cloudflare.com/client/v4';

export type CloudflareDnsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudflareDnsClient {
  constructor(private readonly fetchImpl: CloudflareDnsFetch = fetch) {}

  async findZoneId(token: string, domain: string): Promise<string> {
    const labels = domain.replace(/\.$/, '').split('.').filter(Boolean);
    for (let i = 0; i < labels.length - 1; i += 1) {
      const candidate = labels.slice(i).join('.');
      const payload = await this.request<{ result?: Array<{ id?: string; name?: string }> }>(
        token,
        'GET',
        `/zones?name=${encodeURIComponent(candidate)}`
      );
      const match = payload.result?.find((zone) => zone.name === candidate && zone.id);
      if (match?.id) {
        return match.id;
      }
    }
    throw new Error(`cloudflare zone not found for ${domain}`);
  }

  async createTxt(token: string, zoneId: string, name: string, content: string): Promise<string> {
    const payload = await this.request<{ result?: { id?: string } }>(
      token,
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      {
        type: 'TXT',
        name,
        content,
        ttl: 60,
      }
    );
    if (!payload.result?.id) {
      throw new Error('cloudflare TXT create returned no record id');
    }
    return payload.result.id;
  }

  async deleteRecord(token: string, zoneId: string, id: string): Promise<void> {
    await this.request(
      token,
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`
    );
  }

  private async request<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload: { success?: boolean; errors?: Array<{ message?: string }> } & T;
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      throw new Error(`cloudflare API ${method} ${path} returned non-JSON (${res.status})`);
    }
    if (!res.ok || payload.success === false) {
      const detail = payload.errors
        ?.map((item) => item.message)
        .filter(Boolean)
        .join('; ');
      throw new Error(detail || `cloudflare API ${method} ${path} failed (${res.status})`);
    }
    return payload;
  }
}
