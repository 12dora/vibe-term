import { isIP } from 'node:net';
import type { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import type {
  AcmeChallengeType,
  TlsConfigPublic,
  TlsMode,
} from '../../../../apps/gateway/src/tls/types';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import type { AcmeHttp01Challenge } from './acme-challenge';
import { type AcmeIssueInput, RenewalScheduler, issue as issueAcmeCert } from './acme-service';
import {
  type CaMaterial,
  createCa,
  issueLeaf,
  parseCertificate,
  spkiFingerprint,
} from './cert-authority';
import { CloudflareDnsClient } from './cloudflare-dns';
import { TlsApiError } from './errors';
import type { HttpsListenerConfig, HttpsListenerState } from './https-listener';

const SELF_SIGNED_DAYS = 398;
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ApplyModeInput =
  | { mode: 'none' }
  | { mode: 'external'; trustProxy: boolean }
  | { mode: 'selfsigned'; sans: string[]; tlsPort: number; bindHost: string }
  | {
      mode: 'acme';
      domain: string;
      email: string;
      challenge: AcmeChallengeType;
      cloudflareToken?: string;
      staging: boolean;
      tlsPort: number;
      bindHost: string;
    };

export type TlsStatus = {
  mode: TlsMode;
  trustProxy: boolean;
  tlsPort: number;
  bindHost: string;
  sans: string[];
  caFingerprint: string | null;
  certificate: {
    subject: string;
    sans: string[];
    notBefore: number;
    notAfter: number;
    issuer: string;
  } | null;
  listener: HttpsListenerState;
  acme: {
    email: string;
    domain: string;
    challenge: AcmeChallengeType;
    staging: boolean;
    status: TlsConfigPublic['acmeStatus'];
    lastError: string | null;
    lastAttemptAt: number | null;
    nextRenewAt: number | null;
    hasCloudflareToken: boolean;
  } | null;
  restartRequired: boolean;
};

export type TlsListener = {
  apply(cfg: HttpsListenerConfig | null): Promise<void>;
  state(): HttpsListenerState;
  stop(): Promise<void>;
};

export type TlsServiceOptions = {
  store: TlsConfigStore;
  listener: TlsListener;
  challenge: AcmeHttp01Challenge;
  envPath: string;
  trustProxy?: boolean;
  now?: () => number;
  log?: (message: string) => void;
  fetch?: typeof fetch;
  dns?: CloudflareDnsClient;
  issueAcme?: (input: AcmeIssueInput) => Promise<void>;
  scheduleBackground?: (work: () => Promise<void>) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
};

export class TlsService {
  private trustProxy: boolean;
  private restartRequired = false;
  private issueGeneration = 0;
  private readonly scheduler: RenewalScheduler;
  private readonly now: () => number;
  private readonly dns: CloudflareDnsClient;
  private readonly issueAcmeFn: (input: AcmeIssueInput) => Promise<void>;
  private readonly scheduleBackground: (work: () => Promise<void>) => void;

  constructor(private readonly opts: TlsServiceOptions) {
    this.trustProxy = opts.trustProxy ?? false;
    this.now = opts.now ?? Date.now;
    this.dns = opts.dns ?? new CloudflareDnsClient(opts.fetch);
    this.issueAcmeFn = opts.issueAcme ?? issueAcmeCert;
    this.scheduleBackground =
      opts.scheduleBackground ??
      ((work) => {
        void work().catch((error) => {
          opts.log?.(
            `tls background task failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      });
    this.scheduler = new RenewalScheduler({
      isDue: async () => {
        const row = await this.opts.store.get();
        return (
          row.mode === 'acme' && row.acmeNextRenewAt !== null && this.now() >= row.acmeNextRenewAt
        );
      },
      renew: async () => {
        await this.runAcmeIssue();
      },
      now: this.now,
      setTimeoutFn: opts.setTimeoutFn,
      clearTimeoutFn: opts.clearTimeoutFn,
      log: opts.log,
    });
  }

  async load(): Promise<TlsConfigPublic> {
    const fromEnv = await readTrustProxy(this.opts.envPath);
    if (fromEnv !== null) {
      this.trustProxy = fromEnv;
    }
    return this.opts.store.get();
  }

  async startup(): Promise<void> {
    await this.load();
    const row = await this.opts.store.get();
    if (row.mode === 'selfsigned' || row.mode === 'acme') {
      await this.applyListener();
    } else {
      await this.opts.listener.apply(null);
    }
    if (row.mode === 'acme') {
      this.scheduler.start();
      const due = row.acmeNextRenewAt !== null && this.now() >= row.acmeNextRenewAt;
      if (due) {
        this.scheduleBackground(async () => {
          await this.scheduler.runNow();
        });
      }
    }
  }

  async status(): Promise<TlsStatus> {
    const row = await this.opts.store.get();
    let certificate: TlsStatus['certificate'] = null;
    if (row.certPem) {
      try {
        const parsed = parseCertificate(row.certPem);
        certificate = {
          subject: parsed.subject,
          sans: parsed.sans,
          notBefore: parsed.notBefore,
          notAfter: parsed.notAfter,
          issuer: parsed.issuer,
        };
      } catch {
        certificate = null;
      }
    }
    let caFingerprint: string | null = null;
    if (row.mode === 'selfsigned' && row.caCertPem) {
      caFingerprint = await spkiFingerprint(row.caCertPem);
    }
    return {
      mode: row.mode,
      trustProxy: this.trustProxy,
      tlsPort: row.tlsPort,
      bindHost: row.bindHost,
      sans: row.sans,
      caFingerprint,
      certificate,
      listener: this.opts.listener.state(),
      acme:
        row.mode === 'acme'
          ? {
              email: row.acmeEmail ?? '',
              domain: row.acmeDomain ?? '',
              challenge: row.acmeChallenge ?? 'http-01',
              staging: row.acmeStaging,
              status: row.acmeStatus,
              lastError: row.acmeLastError,
              lastAttemptAt: row.acmeLastAttemptAt,
              nextRenewAt: row.acmeNextRenewAt,
              hasCloudflareToken: row.hasCloudflareToken,
            }
          : null,
      restartRequired: this.restartRequired,
    };
  }

  async caPem(): Promise<string | null> {
    const row = await this.opts.store.get();
    if (row.mode !== 'selfsigned' || !row.caCertPem) {
      return null;
    }
    return row.caCertPem;
  }

  async applyMode(input: ApplyModeInput): Promise<TlsStatus> {
    if (input.mode === 'none') {
      await this.opts.store.upsert({ mode: 'none' });
      this.scheduler.stop();
      await this.opts.listener.apply(null);
      return this.status();
    }
    if (input.mode === 'external') {
      await this.opts.store.upsert({ mode: 'external' });
      this.scheduler.stop();
      await this.opts.listener.apply(null);
      await writeTrustProxy(this.opts.envPath, input.trustProxy);
      this.trustProxy = input.trustProxy;
      this.restartRequired = true;
      return this.status();
    }
    if (input.mode === 'selfsigned') {
      const sans = validateSans(input.sans);
      const tlsPort = validatePort(input.tlsPort);
      const bindHost = validateBindHost(input.bindHost);
      await this.opts.store.upsert({
        mode: 'selfsigned',
        sans,
        tlsPort,
        bindHost,
      });
      this.scheduler.stop();
      try {
        await this.issueSelfSigned(sans);
        await this.applyListener();
      } catch (error) {
        if (error instanceof TlsApiError) throw error;
        throw new TlsApiError(
          'tls_failed',
          500,
          error instanceof Error ? error.message : String(error)
        );
      }
      this.throwIfBindFailed();
      return this.status();
    }
    const domain = validateDomain(input.domain);
    const email = validateEmail(input.email);
    const tlsPort = validatePort(input.tlsPort);
    const bindHost = validateBindHost(input.bindHost);
    if (input.challenge !== 'http-01' && input.challenge !== 'dns-01') {
      throw new TlsApiError('invalid_domain', 400, 'challenge must be http-01 or dns-01');
    }
    const current = await this.opts.store.get();
    if (input.challenge === 'dns-01' && !input.cloudflareToken && !current.hasCloudflareToken) {
      throw new TlsApiError(
        'cloudflare_token_required',
        400,
        'cloudflareToken is required for dns-01'
      );
    }
    await this.opts.store.upsert({
      mode: 'acme',
      tlsPort,
      bindHost,
      sans: [domain],
      acmeDomain: domain,
      acmeEmail: email,
      acmeChallenge: input.challenge,
      acmeStaging: Boolean(input.staging),
      acmeStatus: 'pending',
      acmeLastError: null,
      ...(input.cloudflareToken ? { acmeCfToken: input.cloudflareToken } : {}),
    });
    this.queueAcmeIssue();
    this.scheduler.start();
    return this.status();
  }

  async renew(): Promise<TlsStatus> {
    const row = await this.opts.store.get();
    if (row.mode === 'none' || row.mode === 'external') {
      throw new TlsApiError('not_applicable', 409, 'renew is not applicable in this TLS mode');
    }
    if (row.mode === 'selfsigned') {
      try {
        await this.issueSelfSigned(row.sans);
        await this.applyListener();
      } catch (error) {
        if (error instanceof TlsApiError) throw error;
        throw new TlsApiError(
          'tls_failed',
          500,
          error instanceof Error ? error.message : String(error)
        );
      }
      this.throwIfBindFailed();
      return this.status();
    }
    await this.opts.store.upsert({ acmeStatus: 'pending', acmeLastError: null });
    this.queueAcmeIssue();
    return this.status();
  }

  handleChallenge(req: Request): Response | null {
    return this.opts.challenge.handle(req);
  }

  stop(): void {
    this.scheduler.stop();
  }

  private queueAcmeIssue(): void {
    const generation = ++this.issueGeneration;
    this.scheduleBackground(async () => {
      try {
        await this.runAcmeIssue(generation);
      } catch {
        // issue() already persisted acme_status=error
      }
    });
  }

  private async runAcmeIssue(generation = this.issueGeneration): Promise<void> {
    const row = await this.opts.store.get();
    await this.issueAcmeFn({
      config: {
        domain: row.acmeDomain,
        email: row.acmeEmail,
        challenge: row.acmeChallenge,
        staging: row.acmeStaging,
      },
      store: this.opts.store,
      challenge: this.opts.challenge,
      dns: this.dns,
      fetch: this.opts.fetch,
      log: this.opts.log,
      now: this.now,
    });
    if (generation !== this.issueGeneration) return;
    await this.applyListener();
  }

  private async issueSelfSigned(sans: string[]): Promise<void> {
    const ca = await this.ensureCa();
    const leaf = await issueLeaf({ ca, sans, days: SELF_SIGNED_DAYS });
    const parsed = parseCertificate(leaf.certPem);
    await this.opts.store.upsert({
      certPem: `${leaf.certPem.trim()}\n${ca.certPem.trim()}\n`,
      keyPem: leaf.keyPem,
      certNotBefore: parsed.notBefore,
      certNotAfter: parsed.notAfter,
      sans,
    });
  }

  private async ensureCa(): Promise<CaMaterial> {
    const row = await this.opts.store.get();
    const secrets = await this.opts.store.getPrivateMaterial();
    if (row.caCertPem && secrets.caKeyPem) {
      return { certPem: row.caCertPem, keyPem: secrets.caKeyPem };
    }
    const ca = await createCa({ name: 'tmex local CA' });
    await this.opts.store.upsert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem });
    return ca;
  }

  private async applyListener(): Promise<void> {
    const row = await this.opts.store.get();
    const secrets = await this.opts.store.getPrivateMaterial();
    if (!row.certPem || !secrets.keyPem) {
      await this.opts.listener.apply(null);
      return;
    }
    await this.opts.listener.apply({
      port: row.tlsPort,
      host: row.bindHost,
      certPem: row.certPem,
      keyPem: secrets.keyPem,
    });
  }

  private throwIfBindFailed(): void {
    const error = this.opts.listener.state().error;
    if (error) {
      throw new TlsApiError('port_in_use', 409, error);
    }
  }
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TlsApiError('invalid_port', 400, 'tlsPort must be an integer in 1..65535');
  }
  return value;
}

function validateBindHost(value: string): string {
  const host = value.trim();
  if (!host) {
    throw new TlsApiError('invalid_port', 400, 'bindHost is required');
  }
  return host;
}

function validateSans(sans: string[]): string[] {
  if (!Array.isArray(sans) || sans.length < 1 || sans.length > 20) {
    throw new TlsApiError('invalid_sans', 400, 'sans must contain 1 to 20 hostnames or IPs');
  }
  const normalized = sans.map((item) => item.trim()).filter(Boolean);
  if (normalized.length !== sans.length || !normalized.every(isValidSan)) {
    throw new TlsApiError('invalid_sans', 400, 'each SAN must be a valid hostname or IP');
  }
  return normalized;
}

function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!domain || domain.includes('*') || isIP(domain) !== 0 || !isValidHostname(domain)) {
    throw new TlsApiError('invalid_domain', 400, 'domain must be a hostname without wildcards');
  }
  return domain;
}

function validateEmail(value: string): string {
  const email = value.trim();
  if (!EMAIL_RE.test(email)) {
    throw new TlsApiError('invalid_email', 400, 'email is invalid');
  }
  return email;
}

function isValidSan(value: string): boolean {
  return isIP(value) !== 0 || isValidHostname(value);
}

function isValidHostname(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

async function readTrustProxy(envPath: string): Promise<boolean | null> {
  try {
    const values = await readEnvFile(envPath);
    const raw = values.TMEX_TRUST_PROXY;
    if (raw === undefined) return null;
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeTrustProxy(envPath: string, trustProxy: boolean): Promise<void> {
  let existing: Record<string, string> = {};
  try {
    existing = await readEnvFile(envPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await writeEnvFile(envPath, {
    ...existing,
    TMEX_TRUST_PROXY: trustProxy ? 'true' : 'false',
  });
}
