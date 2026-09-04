import { normalizeRelayUrl } from '../../../shared/src/relay';
import { RelayApiError } from '../commands/relay-shared';
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

function wrapJoinError(error: unknown): RelayPasswordJoinError {
  if (error instanceof RelayPasswordJoinError) return error;
  if (error instanceof RelayCaError || error instanceof RelayApiError) {
    return new RelayPasswordJoinError('join_failed', error.message);
  }
  return new RelayPasswordJoinError(
    'join_failed',
    error instanceof Error ? error.message : String(error)
  );
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
