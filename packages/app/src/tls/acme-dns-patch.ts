import type {
  AcmeChallengeType,
  DnsProviderId,
  TlsConfigPatch,
  TlsConfigPublic,
} from '../../../../apps/gateway/src/tls/types';
import {
  type DnsCredentials,
  normalizeDnsCredentials,
  serializeDnsCredentials,
} from './dns-provider';
import { TlsApiError } from './errors';

export type AcmeDnsPatchInput = {
  challenge: AcmeChallengeType;
  cloudflareToken?: string;
  dnsProvider?: DnsProviderId;
  dnsCredentials?: DnsCredentials;
};

type DnsPatch = Pick<TlsConfigPatch, 'acmeDnsProvider' | 'acmeDnsSecret'>;

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveRequestedProvider(
  input: AcmeDnsPatchInput,
  current: TlsConfigPublic
): DnsProviderId | null {
  const legacyToken = nonempty(input.cloudflareToken);
  return (
    input.dnsProvider ??
    (legacyToken ? 'cloudflare' : null) ??
    current.acmeDnsProvider ??
    (current.hasCloudflareToken ? 'cloudflare' : null)
  );
}

export function resolveIncomingCredentials(
  input: AcmeDnsPatchInput,
  legacyToken: string | undefined
): DnsCredentials | null {
  const incoming = input.dnsCredentials
    ? input.dnsProvider
      ? normalizeDnsCredentials(input.dnsProvider, input.dnsCredentials)
      : null
    : legacyToken
      ? { token: legacyToken }
      : null;

  if (input.dnsCredentials && !input.dnsProvider) {
    throw new TlsApiError('dns_provider_required', 400, 'dnsProvider is required for dns-01');
  }
  if (input.dnsCredentials && input.dnsProvider && !incoming) {
    throw new TlsApiError(
      'dns_credentials_required',
      400,
      'dnsCredentials do not match the selected provider'
    );
  }
  return incoming;
}

export function resolveStoredFallback(
  input: AcmeDnsPatchInput,
  current: TlsConfigPublic,
  requestedProvider: DnsProviderId | null,
  usedNewFields: boolean
): DnsPatch {
  if (input.challenge !== 'dns-01') return {};

  const storedSame =
    Boolean(requestedProvider) &&
    current.acmeDnsProvider === requestedProvider &&
    current.hasDnsCredentials;
  const storedLegacyCloudflare = requestedProvider === 'cloudflare' && current.hasCloudflareToken;
  if (storedSame || storedLegacyCloudflare) return {};

  if (usedNewFields || input.dnsProvider) {
    throw new TlsApiError(
      'dns_credentials_required',
      400,
      'dnsCredentials are required for dns-01'
    );
  }
  throw new TlsApiError('cloudflare_token_required', 400, 'cloudflareToken is required for dns-01');
}

function dnsPatchFromIncoming(
  incoming: DnsCredentials | null,
  requestedProvider: DnsProviderId | null
): DnsPatch | null {
  if (!incoming || !requestedProvider) return null;
  const normalized = normalizeDnsCredentials(requestedProvider, incoming);
  if (!normalized) {
    throw new TlsApiError(
      'dns_credentials_required',
      400,
      'dnsCredentials do not match the selected provider'
    );
  }
  return {
    acmeDnsProvider: requestedProvider,
    acmeDnsSecret: serializeDnsCredentials(normalized),
  };
}

export function resolveAcmeDnsPatch(input: AcmeDnsPatchInput, current: TlsConfigPublic): DnsPatch {
  if (input.challenge !== 'dns-01') {
    if (!input.dnsProvider && !input.dnsCredentials && !nonempty(input.cloudflareToken)) {
      return {};
    }
  }
  const legacyToken = nonempty(input.cloudflareToken);
  const usedNewFields = input.dnsProvider !== undefined || input.dnsCredentials !== undefined;
  const requestedProvider = resolveRequestedProvider(input, current);

  if (input.challenge === 'dns-01' && !requestedProvider) {
    if (usedNewFields) {
      throw new TlsApiError('dns_provider_required', 400, 'dnsProvider is required for dns-01');
    }
    throw new TlsApiError(
      'cloudflare_token_required',
      400,
      'cloudflareToken is required for dns-01'
    );
  }

  const incoming = resolveIncomingCredentials(input, legacyToken);
  const patch = dnsPatchFromIncoming(incoming, requestedProvider);
  if (patch) return patch;

  return resolveStoredFallback(input, current, requestedProvider, usedNewFields);
}
