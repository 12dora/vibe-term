import { RelayCaPinStore } from '../../../../apps/gateway/src/auth/relay-ca-pin-store';
import { normalizeRelayUrl } from '../../../shared/src/relay';
import { t } from '../i18n';
import { fetchPinnedRelayCa } from '../lib/relay-ca';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import type { CliIo } from './cli-io';
import { withAuth } from './with-auth';

function log(io: CliIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

export async function runRelayTrustRefresh(
  parsed: ParsedArgs,
  rawUrl: string,
  io: CliIo = {}
): Promise<{ relayUrl: string; fingerprint: string }> {
  if (!rawUrl.trim()) {
    throw new Error('relay trust refresh requires <url>');
  }
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(rawUrl);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'invalid relay url');
  }
  const fingerprint = (asString(parsed.flags.fingerprint) ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(t('relay.trust.fingerprintInvalid'));
  }
  const caPem = await fetchPinnedRelayCa({
    relayUrl,
    fingerprint,
    fetcher: io.fetcher,
    timeoutMs: io.relayTimeoutMs,
  });
  return await withAuth(parsed, io, async (ctx) => {
    new RelayCaPinStore(ctx.db).put({ url: relayUrl, caPem, fingerprint });
    log(io, t('relay.trust.pinned', { url: relayUrl, fingerprint }));
    log(io, t('relay.trust.restartHint'));
    return { relayUrl, fingerprint };
  });
}
