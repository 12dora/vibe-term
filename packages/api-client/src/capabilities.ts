// GET /api/capabilities 消费与 featureset 判定 helper

import { type ApiClient, defaultApiClient, parseApiError } from './client';

export interface CapabilitiesResponse {
  serverImpl: string;
  serverVersion: string;
  apiVersion: number;
  wsProtocolVersion: number;
  capabilities: string[];
}

export async function fetchCapabilities(
  client: ApiClient = defaultApiClient
): Promise<CapabilitiesResponse> {
  const res = await client.fetch('/api/capabilities');
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load capabilities'));
  }
  return (await res.json()) as CapabilitiesResponse;
}

// capabilities 字符串集合的只读判定包装（REST 与 WS HELLO 共用一种形态）
export class FeatureSet {
  private readonly set: ReadonlySet<string>;

  constructor(capabilities: Iterable<string>) {
    this.set = new Set(capabilities);
  }

  has(capability: string): boolean {
    return this.set.has(capability);
  }

  hasAll(...capabilities: string[]): boolean {
    return capabilities.every((capability) => this.set.has(capability));
  }

  hasAny(...capabilities: string[]): boolean {
    return capabilities.some((capability) => this.set.has(capability));
  }

  list(): string[] {
    return [...this.set];
  }

  static empty(): FeatureSet {
    return new FeatureSet([]);
  }
}
