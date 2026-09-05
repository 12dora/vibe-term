import { RelayPackError, normalizeRelayUrl } from '../../../shared/src/relay';
import { RelayApiError, RelayTimeoutError } from '../commands/relay-shared';
import { errorMessage } from './error-message';
import type { FetchLike } from './fetch-like';
import type { LocalAuthContext } from './local-auth';
import { RelayCaError, fetchPinnedRelayCa, pinRelayCa } from './relay-ca';
import {
  RelayPasswordJoinError,
  joinDownloadVerifyReplay,
  joinKdfProofAndPack,
  joinSelfAdmitAndPersist,
  joinUploadAndEnv,
} from './relay-password-join-flow';

export { RelayPasswordJoinError } from './relay-password-join-flow';

const PACK_API_CODES = new Set([
  'RELAY_PACK_MISSING',
  'RELAY_PACK_EPOCH_MISMATCH',
  'RELAY_PACK_HEAD_AHEAD',
  'RELAY_PACK_TOO_LARGE',
]);

const PASSWORD_API_CODES = new Set(['RELAY_BAD_PROOF', 'RELAY_PASSWORD_INVALID']);

export type RelayPasswordJoinInput = {
  relayUrl: string;
  tenantId: string;
  password: string;
  name?: string;
  caFingerprint?: string;
};

export type RelayPasswordJoinDeps = {
  auth: LocalAuthContext;
  now?: () => number;
  fetcher?: FetchLike;
  timeoutMs?: number;
  afterUnpack?: (pack: Awaited<ReturnType<typeof joinKdfProofAndPack>>) => void | Promise<void>;
};

export type RelayPasswordJoinResult = {
  userId: string;
  relayUrl: string;
  tenantId: string;
};

function parseJoinRelayUrl(raw: string): string {
  try {
    return normalizeRelayUrl(raw);
  } catch (error) {
    throw new RelayPasswordJoinError(
      'invalid_url',
      error instanceof Error ? error.message : 'invalid relay url'
    );
  }
}

function isRelayUnreachableCause(error: unknown): boolean {
  if (error instanceof RelayTimeoutError) return true;
  if (error instanceof RelayCaError) return error.transport;
  if (!(error instanceof Error)) return false;
  if (error.name === 'TypeError') return true;
  const message = error.message.toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('fetch failed') ||
    message.includes('unable to connect')
  );
}

export function wrapRelayPasswordJoinError(error: unknown): RelayPasswordJoinError {
  if (error instanceof RelayPasswordJoinError) {
    if (error.code === 'head_hash_mismatch') {
      return new RelayPasswordJoinError('relay_pack_invalid', error.message);
    }
    return error;
  }
  if (error instanceof RelayPackError) {
    return new RelayPasswordJoinError('relay_pack_invalid', error.message);
  }
  if (error instanceof RelayTimeoutError || isRelayUnreachableCause(error)) {
    return new RelayPasswordJoinError(
      'relay_unreachable',
      error instanceof Error ? error.message : 'relay unreachable'
    );
  }
  if (error instanceof RelayCaError) {
    return new RelayPasswordJoinError('join_failed', error.message);
  }
  if (error instanceof RelayApiError) {
    if (PASSWORD_API_CODES.has(error.code) || error.status === 401) {
      return new RelayPasswordJoinError('relay_password_invalid', error.message);
    }
    if (error.code === 'RELAY_TENANT_NOT_FOUND' || error.status === 404) {
      return new RelayPasswordJoinError('relay_tenant_unknown', error.message);
    }
    if (PACK_API_CODES.has(error.code)) {
      return new RelayPasswordJoinError('relay_pack_invalid', error.message);
    }
    return new RelayPasswordJoinError('join_failed', error.message);
  }
  return new RelayPasswordJoinError('join_failed', errorMessage(error));
}

function wrapJoinError(error: unknown): RelayPasswordJoinError {
  return wrapRelayPasswordJoinError(error);
}

async function assertJoinable(ctx: LocalAuthContext): Promise<void> {
  if (ctx.userStore.listUsers().length > 0) {
    throw new RelayPasswordJoinError(
      'local_user_exists',
      'this machine already has a mesh user; password join refuses to overwrite it'
    );
  }
  const identity = await ctx.identityStore.load();
  if (identity?.userId) {
    throw new RelayPasswordJoinError(
      'local_user_exists',
      'this machine already has a node identity bound to a mesh user'
    );
  }
}

async function pinnedFetcher(input: {
  relayUrl: string;
  caFingerprint: string | undefined;
  fetcher: FetchLike | undefined;
  timeoutMs: number | undefined;
}): Promise<{
  fetcher: FetchLike | undefined;
  pin: { caPem: string; fingerprint: string } | null;
}> {
  if (!input.caFingerprint) return { fetcher: input.fetcher, pin: null };
  const caPem = await fetchPinnedRelayCa({
    relayUrl: input.relayUrl,
    fingerprint: input.caFingerprint,
    fetcher: input.fetcher,
    timeoutMs: input.timeoutMs,
  });
  return {
    fetcher: pinRelayCa(input.fetcher, caPem),
    pin: { caPem, fingerprint: input.caFingerprint },
  };
}

export async function performRelayPasswordJoin(
  input: RelayPasswordJoinInput,
  deps: RelayPasswordJoinDeps
): Promise<RelayPasswordJoinResult> {
  await assertJoinable(deps.auth);
  const relayUrl = parseJoinRelayUrl(input.relayUrl);
  const tenantId = input.tenantId.trim().toLowerCase();
  const { fetcher, pin } = await pinnedFetcher({
    relayUrl,
    caFingerprint: input.caFingerprint,
    fetcher: deps.fetcher,
    timeoutMs: deps.timeoutMs,
  });
  const transport = { relayUrl, tenantId, fetcher, timeoutMs: deps.timeoutMs };
  let pack: Awaited<ReturnType<typeof joinKdfProofAndPack>> | undefined;
  let metaKey: Uint8Array | undefined;
  try {
    pack = await joinKdfProofAndPack({
      ...transport,
      password: input.password,
      now: deps.now?.() ?? Date.now(),
    });
    await deps.afterUnpack?.(pack);
    const log = await joinDownloadVerifyReplay(transport, pack);
    const admit = await joinSelfAdmitAndPersist({
      auth: deps.auth,
      transport,
      pack,
      log,
      name: input.name,
    });
    metaKey = admit.metaKey;
    await joinUploadAndEnv({ auth: deps.auth, transport, pack, log, admit, pin });
    return { userId: log.genesisUid, relayUrl, tenantId };
  } catch (error) {
    throw wrapJoinError(error);
  } finally {
    pack?.pack.log_key.fill(0);
    pack?.pack.token.fill(0);
    pack?.rootKey.seed.fill(0);
    metaKey?.fill(0);
  }
}
