// `settings tls set` 的请求体：字段与 GUI `tls-form.ts` / `acme-dns-fields.tsx` → `TlsApi.update` 对齐。

import type { FlagValues } from './args';
import { flagNumber, flagString } from './args';
import { mergeBody, parseOnOff, readSecretField } from './cmd';
import type { CliContext } from './context';
import { UsageError } from './errors';
import { optionalObjectBody, splitCsv } from './settings-body';

const TLS_MODES = new Set(['none', 'external', 'selfsigned', 'acme']);
const TLS_CHALLENGES = new Set(['http-01', 'dns-01']);
const TLS_DNS_PROVIDERS = new Set(['cloudflare', 'dnspod']);
const DEFAULT_TLS_PORT = 9443;
const DEFAULT_TLS_BIND_HOST = '0.0.0.0';

function requireTlsMode(raw: string | undefined): string {
  if (!raw) {
    throw new UsageError(
      'tls set requires --mode or --body',
      'use --mode none|external|selfsigned|acme'
    );
  }
  if (!TLS_MODES.has(raw)) {
    throw new UsageError(`unknown tls mode: ${raw}`, 'use none|external|selfsigned|acme');
  }
  return raw;
}

function tlsPort(flags: FlagValues): number {
  return flagNumber(flags, 'port') ?? DEFAULT_TLS_PORT;
}

function tlsBindHost(flags: FlagValues): string {
  return flagString(flags, 'bind-host') ?? DEFAULT_TLS_BIND_HOST;
}

function selfSignedSans(flags: FlagValues): string[] {
  const sans = splitCsv(flagString(flags, 'sans'));
  if (sans.length === 0) {
    throw new UsageError('tls set --mode selfsigned requires --sans', 'pass --sans host,ip');
  }
  return sans;
}

function optionalOnOff(flags: FlagValues, name: string): boolean | undefined {
  const raw = flagString(flags, name);
  if (!raw) return undefined;
  return parseOnOff(raw);
}

async function acmeDnsFields(
  ctx: CliContext,
  flags: FlagValues,
  challenge: string
): Promise<Record<string, unknown>> {
  if (challenge !== 'dns-01') return {};
  const provider = flagString(flags, 'dns-provider') ?? 'cloudflare';
  if (!TLS_DNS_PROVIDERS.has(provider)) {
    throw new UsageError(`unknown --dns-provider: ${provider}`, 'use cloudflare|dnspod');
  }
  const token = await readSecretField(ctx, flags, {
    flag: 'dns-token',
    envName: 'VIBETERM_TLS_DNS_TOKEN',
  });
  const secretId = flagString(flags, 'dns-secret-id') ?? process.env.VIBETERM_TLS_DNS_SECRET_ID;
  const fields: Record<string, unknown> = { dnsProvider: provider };
  if (!token) return fields;
  if (provider === 'dnspod') {
    if (!secretId) {
      throw new UsageError(
        'dns-01 dnspod requires --dns-secret-id (or VIBETERM_TLS_DNS_SECRET_ID)'
      );
    }
    fields.dnsCredentials = { id: secretId, token };
    return fields;
  }
  fields.dnsCredentials = { token };
  return fields;
}

async function acmeBody(ctx: CliContext, flags: FlagValues): Promise<Record<string, unknown>> {
  const domain = flagString(flags, 'domain');
  const email = flagString(flags, 'email');
  if (!domain || !email) {
    throw new UsageError(
      'tls set --mode acme requires --domain and --email',
      'pass --domain example.com --email ops@example.com'
    );
  }
  const challenge = flagString(flags, 'challenge') ?? 'http-01';
  if (!TLS_CHALLENGES.has(challenge)) {
    throw new UsageError(`unknown --challenge: ${challenge}`, 'use http-01|dns-01');
  }
  return {
    mode: 'acme',
    domain,
    email,
    challenge,
    staging: optionalOnOff(flags, 'staging') ?? false,
    tlsPort: tlsPort(flags),
    bindHost: tlsBindHost(flags),
    ...(await acmeDnsFields(ctx, flags, challenge)),
  };
}

async function buildModeBody(
  ctx: CliContext,
  flags: FlagValues,
  mode: string
): Promise<Record<string, unknown>> {
  if (mode === 'none') return { mode: 'none' };
  if (mode === 'external') {
    return { mode: 'external', trustProxy: optionalOnOff(flags, 'trust-proxy') ?? false };
  }
  if (mode === 'selfsigned') {
    return {
      mode: 'selfsigned',
      sans: selfSignedSans(flags),
      tlsPort: tlsPort(flags),
      bindHost: tlsBindHost(flags),
    };
  }
  return acmeBody(ctx, flags);
}

export async function tlsSetBody(
  ctx: CliContext,
  flags: FlagValues
): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const modeFlag = flagString(flags, 'mode');
  if (!modeFlag) {
    const mode = typeof extra?.mode === 'string' ? extra.mode : undefined;
    requireTlsMode(mode);
    return extra as Record<string, unknown>;
  }
  return mergeBody(await buildModeBody(ctx, flags, requireTlsMode(modeFlag)), extra);
}
