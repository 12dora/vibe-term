import { promises as dnsPromises } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import acme from 'acme-client';
import type { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import type { AcmeChallengeType } from '../../../../apps/gateway/src/tls/types';
import type { FetchLike } from '../lib/fetch-like';
import type { AcmeHttp01Challenge } from './acme-challenge';
import { parseCertificate } from './cert-authority';
import type { DnsCredentials, DnsProvider, DnsProviderId, DnsTxtRef } from './dns-provider';
import { resolveStoredDnsCredentials } from './dns-provider';

export const ACME_RENEW_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
export const RENEWAL_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const RENEWAL_BACKOFF_MIN_MS = 60 * 60 * 1000;
export const RENEWAL_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
export const DNS_PROPAGATION_INTERVAL_MS = 2000;
export const DNS_PROPAGATION_TIMEOUT_MS = 120_000;

type AcmeAuthorization = { identifier: { type: string; value: string } };
type AcmeChallenge = { type: string; token: string };
type ChallengeFn = (
  authz: AcmeAuthorization,
  challenge: AcmeChallenge,
  keyAuthorization: string
) => Promise<unknown>;

export type AcmeClientLike = {
  createAccount(data?: { contact?: string[]; termsOfServiceAgreed?: boolean }): Promise<unknown>;
  getAccountUrl(): string;
  auto(opts: {
    csr: string | Buffer;
    email?: string;
    termsOfServiceAgreed?: boolean;
    challengePriority?: string[];
    skipChallengeVerification?: boolean;
    challengeCreateFn: ChallengeFn;
    challengeRemoveFn: ChallengeFn;
  }): Promise<string>;
};

type AcmeClientFactory = (opts: {
  directoryUrl: string;
  accountKey: string;
  accountUrl?: string;
}) => AcmeClientLike | Promise<AcmeClientLike>;

export type ResolveTxtFn = (hostname: string, nameservers?: string[]) => Promise<string[][]>;

export type AcmeIssuedMaterial = {
  certPem: string;
  keyPem: string;
  notBefore: number;
  notAfter: number;
  nextRenewAt: number;
  accountKey: string;
  accountUrl: string;
  directoryUrl: string;
  domain: string;
  cleanupWarning: string | null;
};

export type AcmeIssueInput = {
  config?: {
    domain?: string | null;
    email?: string | null;
    challenge?: AcmeChallengeType | null;
    staging?: boolean;
  };
  store: TlsConfigStore;
  challenge: AcmeHttp01Challenge;
  dns: DnsProvider;
  log?: (message: string) => void;
  now?: () => number;
  clientFactory?: AcmeClientFactory;
  signal?: AbortSignal;
  resolveTxt?: ResolveTxtFn;
  dnsIntervalMs?: number;
  dnsTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type PendingChallenges = {
  dns: Array<{ ref: DnsTxtRef; token: string }>;
  http: string[];
  failures: string[];
};

type AccountRow = { acmeAccountUrl: string | null; acmeAccountDirectory: string | null };

function asPem(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function acmeDirectoryUrl(staging: boolean): string {
  return staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('acme issuance aborted');
}

async function resolveNameserverIps(nameservers: string[]): Promise<string[]> {
  const ips: string[] = [];
  for (const ns of nameservers) {
    if (isIP(ns) !== 0) {
      ips.push(ns);
      continue;
    }
    for (const result of await Promise.allSettled([
      dnsPromises.resolve4(ns),
      dnsPromises.resolve6(ns),
    ])) {
      if (result.status === 'fulfilled') ips.push(...result.value);
    }
  }
  return ips;
}

function txtResolver(servers?: string[]): Resolver {
  const resolver = new Resolver({ timeout: 3_000, tries: 1 });
  if (servers) resolver.setServers(servers);
  return resolver;
}

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const RESOLVE_ATTEMPT_TIMEOUT_MS = 8_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** UDP 53 在代理/受限网络下常不可达，先走 DNS-over-HTTPS（可过 HTTP 代理），再退到权威 NS 与系统解析器。 */
export async function resolveTxtOverHttps(
  hostname: string,
  fetchImpl: FetchLike = fetch,
  endpoint = DOH_ENDPOINT
): Promise<string[][]> {
  const url = new URL(endpoint);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', 'TXT');
  const response = await fetchImpl(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(RESOLVE_ATTEMPT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`doh ${response.status}`);
  const body = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
  return (body.Answer ?? [])
    .filter((answer) => answer.type === 16)
    .map((answer) => [answer.data.replace(/^"|"$/g, '').replace(/"\s*"/g, '')]);
}

async function defaultResolveTxt(hostname: string, nameservers?: string[]): Promise<string[][]> {
  try {
    return await resolveTxtOverHttps(hostname);
  } catch {
    // fall through to UDP resolvers
  }
  if (nameservers && nameservers.length > 0) {
    try {
      const ips = await withTimeout(
        resolveNameserverIps(nameservers),
        RESOLVE_ATTEMPT_TIMEOUT_MS,
        'nameserver lookup'
      );
      if (ips.length > 0) {
        return await withTimeout(
          txtResolver(ips).resolveTxt(hostname),
          RESOLVE_ATTEMPT_TIMEOUT_MS,
          'authoritative TXT lookup'
        );
      }
    } catch {
      // fall through to the system resolver
    }
  }
  return withTimeout(
    txtResolver().resolveTxt(hostname),
    RESOLVE_ATTEMPT_TIMEOUT_MS,
    'system TXT lookup'
  );
}

export async function waitForTxt(opts: {
  hostname: string;
  value: string;
  nameservers?: string[];
  resolveTxt?: ResolveTxtFn;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<void> {
  const intervalMs = opts.intervalMs ?? DNS_PROPAGATION_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DNS_PROPAGATION_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const resolveTxt = opts.resolveTxt ?? defaultResolveTxt;
  const deadline = now() + timeoutMs;
  const visible = async (): Promise<boolean> => {
    throwIfAborted(opts.signal);
    try {
      return (await resolveTxt(opts.hostname, opts.nameservers)).flat().includes(opts.value);
    } catch {
      return false;
    }
  };
  while (!(await visible())) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`dns-01 TXT ${opts.hostname} did not propagate within ${timeoutMs}ms`);
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

async function openAccount(
  input: AcmeIssueInput,
  current: AccountRow,
  accountKey: string,
  directoryUrl: string,
  email: string
): Promise<{ client: AcmeClientLike; accountUrl: string }> {
  const reuse = Boolean(current.acmeAccountUrl) && current.acmeAccountDirectory === directoryUrl;
  const factory =
    input.clientFactory ?? ((opts) => new acme.Client(opts) as unknown as AcmeClientLike);
  const client = await factory({
    directoryUrl,
    accountKey,
    accountUrl: reuse ? (current.acmeAccountUrl ?? undefined) : undefined,
  });
  if (!reuse) {
    await client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${email}`] });
  }
  throwIfAborted(input.signal);
  return {
    client,
    accountUrl: client.getAccountUrl() || (reuse ? (current.acmeAccountUrl ?? '') : ''),
  };
}

function dnsLogPrefix(providerId: DnsProviderId): string {
  return `acme dns-01 ${providerId}`;
}

async function createChallenge(
  input: AcmeIssueInput,
  creds: DnsCredentials | null,
  providerId: DnsProviderId,
  pending: PendingChallenges,
  now: () => number,
  authz: AcmeAuthorization,
  challenge: AcmeChallenge,
  keyAuthorization: string
): Promise<void> {
  throwIfAborted(input.signal);
  if (challenge.type === 'http-01') {
    input.challenge.set(challenge.token, keyAuthorization);
    pending.http.push(challenge.token);
    return;
  }
  if (challenge.type !== 'dns-01') throw new Error(`unsupported acme challenge ${challenge.type}`);
  if (!creds) {
    throw new Error(
      providerId === 'cloudflare'
        ? 'cloudflare token required for dns-01'
        : `${providerId} credentials required for dns-01`
    );
  }
  const domain = authz.identifier.value;
  const name = `_acme-challenge.${domain}`;
  const ref = await input.dns.createTxt(creds, name, keyAuthorization);
  pending.dns.push({ ref, token: challenge.token });
  let nameservers: string[] | undefined;
  if (ref.zone && input.dns.getNameServers) {
    try {
      nameservers = await input.dns.getNameServers(creds, ref.zone);
    } catch (error) {
      input.log?.(
        `${dnsLogPrefix(providerId)} nameserver lookup failed, using system resolver: ${errMsg(error)}`
      );
    }
  }
  await waitForTxt({
    hostname: name,
    value: keyAuthorization,
    nameservers: nameservers?.length ? nameservers : undefined,
    resolveTxt: input.resolveTxt,
    intervalMs: input.dnsIntervalMs,
    timeoutMs: input.dnsTimeoutMs,
    sleep: input.sleep,
    now,
    signal: input.signal,
  });
}

async function removeChallenge(
  input: AcmeIssueInput,
  creds: DnsCredentials | null,
  providerId: DnsProviderId,
  pending: PendingChallenges,
  challenge: AcmeChallenge
): Promise<void> {
  if (challenge.type === 'http-01') {
    input.challenge.clear(challenge.token);
    const idx = pending.http.indexOf(challenge.token);
    if (idx >= 0) pending.http.splice(idx, 1);
    return;
  }
  if (challenge.type !== 'dns-01') return;
  const storedIdx = pending.dns.findIndex((item) => item.token === challenge.token);
  const stored = storedIdx >= 0 ? pending.dns[storedIdx] : undefined;
  if (!creds || !stored) return;
  try {
    await input.dns.deleteTxt(creds, stored.ref);
    pending.dns.splice(storedIdx, 1);
  } catch (error) {
    input.log?.(
      `${dnsLogPrefix(providerId)} challengeRemoveFn failed for ${stored.ref.recordId}: ${errMsg(error)}`
    );
  }
}

async function cleanupChallenges(
  input: AcmeIssueInput,
  creds: DnsCredentials | null,
  providerId: DnsProviderId,
  pending: PendingChallenges
): Promise<void> {
  while (pending.dns.length > 0) {
    const rec = pending.dns.pop();
    if (!rec) continue;
    if (!creds) {
      pending.failures.push(`missing ${providerId} credentials for ${rec.ref.recordId}`);
      continue;
    }
    try {
      await input.dns.deleteTxt(creds, rec.ref);
    } catch (error) {
      pending.failures.push(`${rec.ref.recordId}: ${errMsg(error)}`);
      input.log?.(
        `${dnsLogPrefix(providerId)} cleanup failed for ${rec.ref.recordId}: ${errMsg(error)}`
      );
    }
  }
  for (const token of pending.http) input.challenge.clear(token);
  pending.http.length = 0;
}

export async function issue(input: AcmeIssueInput): Promise<AcmeIssuedMaterial> {
  const now = input.now ?? Date.now;
  throwIfAborted(input.signal);
  const current = await input.store.get();
  const domain = (input.config?.domain ?? current.acmeDomain ?? '').trim();
  const email = (input.config?.email ?? current.acmeEmail ?? '').trim();
  const challengeType = input.config?.challenge ?? current.acmeChallenge;
  const staging = input.config?.staging ?? current.acmeStaging;
  if (!domain || !email || !challengeType) {
    throw new Error('acme issuance is missing domain, email, or challenge');
  }
  const secrets = await input.store.getPrivateMaterial();
  const accountKey =
    secrets.acmeAccountKey ?? asPem(await acme.crypto.createPrivateEcdsaKey('P-256'));
  const directoryUrl = acmeDirectoryUrl(Boolean(staging));
  const { client, accountUrl } = await openAccount(input, current, accountKey, directoryUrl, email);
  const leafKey = asPem(await acme.crypto.createPrivateEcdsaKey('P-256'));
  const [, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: [domain] }, leafKey);
  const pending: PendingChallenges = { dns: [], http: [], failures: [] };
  const storedDns = resolveStoredDnsCredentials(
    { acmeDnsProvider: current.acmeDnsProvider },
    { acmeDnsSecret: secrets.acmeDnsSecret, acmeCfToken: secrets.acmeCfToken }
  );
  const creds = storedDns.credentials;
  const providerId = input.dns.id;
  let certPem: string | undefined;
  try {
    certPem = await client.auto({
      csr: asPem(csr),
      email,
      termsOfServiceAgreed: true,
      challengePriority: [challengeType],
      skipChallengeVerification: true,
      challengeCreateFn: (authz, challenge, keyAuthorization) =>
        createChallenge(input, creds, providerId, pending, now, authz, challenge, keyAuthorization),
      challengeRemoveFn: (_authz, challenge) =>
        removeChallenge(input, creds, providerId, pending, challenge),
    });
    throwIfAborted(input.signal);
  } finally {
    await cleanupChallenges(input, creds, providerId, pending);
  }
  if (!certPem) throw new Error('acme auto returned an empty certificate');
  const parsed = parseCertificate(certPem);
  return {
    certPem,
    keyPem: leafKey,
    notBefore: parsed.notBefore,
    notAfter: parsed.notAfter,
    nextRenewAt: parsed.notAfter - ACME_RENEW_LEAD_MS,
    accountKey,
    accountUrl,
    directoryUrl,
    domain,
    cleanupWarning:
      pending.failures.length > 0 ? `dns-01 cleanup failed: ${pending.failures.join('; ')}` : null,
  };
}

type RenewalSchedulerOptions = {
  isDue: () => boolean | Promise<boolean>;
  renew: () => Promise<void>;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  checkIntervalMs?: number;
  log?: (message: string) => void;
};

export class RenewalScheduler {
  private timer: unknown = null;
  private stopped = true;
  private backoffMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (id: unknown) => void;
  private readonly checkIntervalMs: number;

  constructor(private readonly opts: RenewalSchedulerOptions) {
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    this.checkIntervalMs = opts.checkIntervalMs ?? RENEWAL_CHECK_INTERVAL_MS;
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
  }

  get nextBackoffMs(): number {
    return this.backoffMs;
  }

  start(): void {
    this.stopped = false;
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
    this.arm(this.checkIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  resetBackoff(): void {
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
  }

  retryAfterFailure(detail?: string): void {
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RENEWAL_BACKOFF_MAX_MS);
    this.opts.log?.(
      detail
        ? `tls renewal failed, retry in ${wait}ms: ${detail}`
        : `tls renewal failed, retry in ${wait}ms`
    );
    this.arm(wait);
  }

  async runNow(): Promise<void> {
    await this.tick(true);
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => {
      void this.tick(false);
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  private async tick(force: boolean): Promise<void> {
    if (this.stopped && !force) return;
    try {
      if (force || (await this.opts.isDue())) {
        await this.opts.renew();
      }
      this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
      this.arm(this.checkIntervalMs);
    } catch (error) {
      this.retryAfterFailure(errMsg(error));
    }
  }
}
