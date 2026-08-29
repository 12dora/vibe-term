import { isIP } from 'node:net';
import type { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import type {
  AcmeChallengeType,
  TlsConfigPublic,
  TlsMode,
} from '../../../../apps/gateway/src/tls/types';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import type { AcmeHttp01Challenge } from './acme-challenge';
import {
  ACME_RENEW_LEAD_MS,
  type AcmeIssueInput,
  type AcmeIssuedMaterial,
  RENEWAL_BACKOFF_MIN_MS,
  RenewalScheduler,
  acmeDirectoryUrl,
  issue as issueAcmeCert,
} from './acme-service';
import {
  CA_MIN_REMAINING_MS,
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

export type AcmeRunReason = 'apply' | 'renew' | 'scheduler' | 'startup';

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
  issueAcme?: (input: AcmeIssueInput) => Promise<AcmeIssuedMaterial>;
  scheduleBackground?: (work: () => Promise<void>) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
};

type AcmeJobTuple = {
  domain: string;
  challenge: AcmeChallengeType | null;
  staging: boolean;
};

class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

export class TlsService {
  private trustProxy: boolean;
  private restartRequired = false;
  private epoch = 0;
  private abortController = new AbortController();
  private acmeInFlight: Promise<void> | null = null;
  private readonly mutex = new SerialQueue();
  private readonly scheduler: RenewalScheduler;
  private readonly now: () => number;
  private readonly dns: CloudflareDnsClient;
  private readonly issueAcmeFn: (input: AcmeIssueInput) => Promise<AcmeIssuedMaterial>;
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
        await this.runAcme('scheduler', this.epoch, this.abortController.signal);
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
    await this.mutex.run(async () => {
      await this.load();
      const row = await this.opts.store.get();
      if (row.mode === 'selfsigned' || row.mode === 'acme') {
        await this.applyListener();
      } else {
        await this.opts.listener.apply(null);
      }
      if (row.mode !== 'acme') return;
      this.scheduler.start();
      const bindError = this.opts.listener.state().error;
      const due = row.acmeNextRenewAt !== null && this.now() >= row.acmeNextRenewAt;
      const needsResume =
        row.acmeStatus === 'pending' ||
        row.acmeStatus === 'error' ||
        !row.certPem ||
        due ||
        Boolean(bindError);
      if (needsResume) {
        this.queueAcmeIssue('startup');
      }
    });
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
    return this.mutex.run(() => this.applyModeLocked(input));
  }

  async renew(): Promise<TlsStatus> {
    return this.mutex.run(async () => {
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
      await this.opts.store.upsert({
        acmeStatus: 'pending',
        acmeLastError: null,
        acmeNextRenewAt: this.now() + RENEWAL_BACKOFF_MIN_MS,
      });
      this.queueAcmeIssue('renew');
      return this.status();
    });
  }

  handleChallenge(req: Request): Response | null {
    return this.opts.challenge.handle(req);
  }

  stop(): void {
    this.invalidateActiveWork();
    this.scheduler.stop();
  }

  private async applyModeLocked(input: ApplyModeInput): Promise<TlsStatus> {
    if (input.mode === 'external') {
      try {
        await withEnvLock(async () => {
          await writeTrustProxy(this.opts.envPath, input.trustProxy);
        });
      } catch (error) {
        throw new TlsApiError(
          'tls_failed',
          500,
          error instanceof Error ? error.message : String(error)
        );
      }
      this.invalidateActiveWork();
      await this.opts.store.upsert({ mode: 'external' });
      this.scheduler.stop();
      await this.opts.listener.apply(null);
      this.trustProxy = input.trustProxy;
      this.restartRequired = true;
      return this.status();
    }

    this.invalidateActiveWork();

    if (input.mode === 'none') {
      await this.opts.store.upsert({ mode: 'none' });
      this.scheduler.stop();
      await this.opts.listener.apply(null);
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
    const directoryUrl = acmeDirectoryUrl(Boolean(input.staging));
    const directoryChanged = current.acmeAccountDirectory !== directoryUrl;
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
      acmeNextRenewAt: this.now() + RENEWAL_BACKOFF_MIN_MS,
      acmeAccountDirectory: directoryUrl,
      ...(directoryChanged ? { acmeAccountUrl: null } : {}),
      ...(input.cloudflareToken ? { acmeCfToken: input.cloudflareToken } : {}),
    });
    this.queueAcmeIssue('apply');
    this.scheduler.start();
    return this.status();
  }

  private invalidateActiveWork(): void {
    this.epoch += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  private queueAcmeIssue(reason: AcmeRunReason): void {
    const epoch = this.epoch;
    const signal = this.abortController.signal;
    this.scheduleBackground(async () => {
      try {
        await this.runAcme(reason, epoch, signal);
      } catch {
        this.scheduler.retryAfterFailure();
      }
    });
  }

  private async runAcme(reason: AcmeRunReason, epoch: number, signal: AbortSignal): Promise<void> {
    if (this.acmeInFlight) {
      await this.acmeInFlight.catch(() => undefined);
    }
    if (epoch !== this.epoch || signal.aborted) return;
    const work = this.doRunAcme(reason, epoch, signal);
    this.acmeInFlight = work.finally(() => {
      if (this.acmeInFlight === work) {
        this.acmeInFlight = null;
      }
    });
    await this.acmeInFlight;
  }

  private async doRunAcme(
    reason: AcmeRunReason,
    epoch: number,
    signal: AbortSignal
  ): Promise<void> {
    if (epoch !== this.epoch || signal.aborted) return;
    const row = await this.opts.store.get();
    if (row.mode !== 'acme') return;
    const tuple: AcmeJobTuple = {
      domain: row.acmeDomain ?? '',
      challenge: row.acmeChallenge,
      staging: row.acmeStaging,
    };
    const secrets = await this.opts.store.getPrivateMaterial();
    const certDue =
      row.certNotAfter !== null && this.now() >= row.certNotAfter - ACME_RENEW_LEAD_MS;
    const hasMaterial = Boolean(row.certPem) && Boolean(secrets.keyPem);
    const activateOnly =
      hasMaterial && !certDue && (reason === 'scheduler' || reason === 'startup');

    if (activateOnly) {
      await this.mutex.run(async () => {
        if (!(await this.jobStillValid(epoch, tuple))) return;
        await this.applyListener();
        const bindError = this.opts.listener.state().error;
        if (bindError) {
          await this.persistAcmeFailure(bindError);
          throw new Error(bindError);
        }
        await this.opts.store.upsert({
          acmeStatus: 'ok',
          acmeLastError: null,
          acmeLastAttemptAt: this.now(),
          acmeNextRenewAt: (row.certNotAfter ?? this.now()) - ACME_RENEW_LEAD_MS,
        });
        this.scheduler.resetBackoff();
      });
      return;
    }

    await this.mutex.run(async () => {
      if (!(await this.jobStillValid(epoch, tuple))) return;
      await this.opts.store.upsert({
        acmeStatus: 'pending',
        acmeLastAttemptAt: this.now(),
        acmeLastError: null,
      });
    });
    if (!(await this.jobStillValid(epoch, tuple)) || signal.aborted) return;

    let material: AcmeIssuedMaterial;
    try {
      material = await this.issueAcmeFn({
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
        signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.mutex.run(async () => {
        if (!(await this.jobStillValid(epoch, tuple))) return;
        await this.persistAcmeFailure(message);
      });
      throw error;
    }

    await this.mutex.run(async () => {
      if (!(await this.jobStillValid(epoch, tuple)) || signal.aborted) {
        this.opts.log?.('discarding stale acme issuance');
        return;
      }
      await this.opts.store.upsert({
        certPem: material.certPem,
        keyPem: material.keyPem,
        certNotBefore: material.notBefore,
        certNotAfter: material.notAfter,
        sans: [material.domain],
        acmeAccountKey: material.accountKey,
        acmeAccountUrl: material.accountUrl || null,
        acmeAccountDirectory: material.directoryUrl,
        acmeLastAttemptAt: this.now(),
        acmeNextRenewAt: material.nextRenewAt,
        acmeStatus: 'ok',
        acmeLastError: material.cleanupWarning,
      });
      await this.applyListener();
      const bindError = this.opts.listener.state().error;
      if (bindError) {
        await this.persistAcmeFailure(bindError);
        throw new Error(bindError);
      }
      this.scheduler.resetBackoff();
    });
  }

  private async jobStillValid(epoch: number, tuple: AcmeJobTuple): Promise<boolean> {
    if (epoch !== this.epoch) return false;
    const current = await this.opts.store.get();
    return (
      current.mode === 'acme' &&
      (current.acmeDomain ?? '') === tuple.domain &&
      current.acmeChallenge === tuple.challenge &&
      Boolean(current.acmeStaging) === Boolean(tuple.staging)
    );
  }

  private async persistAcmeFailure(message: string): Promise<void> {
    await this.opts.store.upsert({
      acmeStatus: 'error',
      acmeLastError: message,
      acmeLastAttemptAt: this.now(),
      acmeNextRenewAt: this.now() + this.scheduler.nextBackoffMs,
    });
  }

  private async issueSelfSigned(sans: string[]): Promise<void> {
    const ca = await this.ensureCa();
    const leaf = await issueLeaf({ ca, sans, days: SELF_SIGNED_DAYS, now: this.now() });
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
      const parsed = parseCertificate(row.caCertPem);
      if (parsed.notAfter - this.now() >= CA_MIN_REMAINING_MS) {
        return { certPem: row.caCertPem, keyPem: secrets.caKeyPem };
      }
      this.opts.log?.(
        'tls CA remaining validity below 30 days, rotating CA; joined nodes must re-join'
      );
    }
    const ca = await createCa({ name: 'tmex local CA', now: this.now() });
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
