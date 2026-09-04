import { HubTrustStore } from '../../../../apps/gateway/src/auth/hub-trust-store';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import { enrollmentTokens, meshHubs, nodes } from '../../../../apps/gateway/src/db/schema';
import {
  envPeerSet,
  hubAuthListColumn,
  lookupSignedHubAuthorization,
  resolveHubAuthorization,
  resolveMeshUserId,
} from '../../../../apps/gateway/src/hub/hub-authorization';
import { HubRoleTransitionStore } from '../../../../apps/gateway/src/hub/hub-role-transitions';
import { encodeRedeemPopMessage } from '../../../../apps/gateway/src/hub/redeem-pop';
import {
  type RootKey,
  bytesEqual,
  canonicalHubUrl,
  createNodeCertificate,
  decodeBase64url,
  decodeCertificate,
  decodeJoinToken,
  decodeKeyLogRecord,
  deriveTotpKey,
  encodeBase64url,
  encodeSetTotpPayload,
  encryptTotpSecret,
  randomBytes,
  rootKeyFromSeed,
  signEd25519,
  verifyKeyLogChain,
} from '../../../shared/src/auth';
import { isRelayJoinToken } from '../../../shared/src/relay';
import { t } from '../i18n';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { pathExists } from '../lib/fs-utils';
import {
  type HubFetch,
  type RedeemResponse,
  assertHubJoinUrl,
  fetchAuthMode,
  isNetworkFetchError,
  redeemEnrollment,
} from '../lib/hub-client';
import { requestEnrollmentByPassword, wipeRootKey } from '../lib/hub-password-join';
import { publishHubJoinSelfAdmit } from '../lib/hub-password-self-admit';
import { applyHubUserPasswd, mapPasswdApplyError } from '../lib/hub-user-passwd';
import { applyHubModeEnvKeys, parseHubPeerIds } from '../lib/install';
import { createInstallLayout } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { joinUserKeyService, makeReplayPasskeyVerifier } from '../lib/keylog-passkey-replay';
import { type LocalAuthContext, loadInstallEnv } from '../lib/local-auth';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from '../lib/password';
import { parseAndValidateCaPem, readBoundedResponseText } from '../lib/pem';
import { type ServiceManagerKind, detectServiceManager } from '../lib/platform';
import { isInteractiveStdin, promptConfirm } from '../lib/prompt';
import { DEFAULT_PEER_PORT, type TmexRoles, parseTmexRoles, roleNameFromFlags } from '../lib/roles';
import { restartService, startService, stopService } from '../lib/service';
import { fingerprintPublicKey, totpOtpauthUri } from '../lib/totp-uri';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import type { InstallMeta } from '../types';
import { assertChainUids, assertResponseCertsMatchProjections } from './hub-join-verify';
import { withAuth } from './with-auth';

export type HubIo = {
  log?: (message: string) => void;
  password?: string;
  oldPassword?: string;
  newPassword?: string;
  restart?: (serviceName: string, installDir: string) => Promise<void>;
  auth?: LocalAuthContext;
  now?: () => number;
  fetcher?: HubFetch;
  insecureLocal?: boolean;
  skipRestart?: boolean;
  stop?: (serviceName: string, installDir: string) => Promise<void>;
  start?: (serviceName: string, installDir: string) => Promise<void>;
  nodeEnv?: string;
  totpCode?: string;
  serviceManager?: ServiceManagerKind;
  confirm?: () => boolean | Promise<boolean>;
  /** r3 加入时每个中继请求的超时（毫秒）；只在测试里下调。 */
  relayTimeoutMs?: number;
};

export type HubListRow = {
  hubNodeId: string;
  name: string | null;
  mode: 'active' | 'standby';
  priority: number;
  writerEpoch: number;
  publicUrl: string;
  online: boolean;
  lastSeenAt: number | null;
  writer: boolean;
  authorized: boolean;
  authorization: 'signed' | 'env' | 'self' | 'no';
};

export const HUB_SIGNED_AUTH_PRECEDENCE_NOTE =
  'signed admit-hub/retire-hub takes precedence over TMEX_HUB_PEERS; manage signed authorization from the UI';

export const HUB_MANUAL_RESTART_HINT =
  'skipped service restart; restart tmex manually to apply the change';

export const NODE_REVOKED_REJOIN_ERROR =
  'this node identity was revoked; use a fresh identity (mesh reset / re-init)';

export { mapPasswdApplyError };

export type JoinErrorCode =
  | 'invalid_token'
  | 'invalid_url'
  | 'node_revoked'
  | 'node_exists'
  | 'hub_unreachable'
  | 'join_failed';

export class JoinError extends Error {
  readonly code: JoinErrorCode;

  constructor(code: JoinErrorCode, message: string) {
    super(message);
    this.name = 'JoinError';
    this.code = code;
  }
}

export type PerformHubJoinInput = {
  hubUrl: string;
  token: string;
  name: string;
  insecureLocal?: boolean;
  nodeEnv?: string;
};

export type PerformHubJoinDeps = {
  auth: LocalAuthContext;
  now?: () => number;
  fetcher?: HubFetch;
};

function joinErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function toJoinError(error: unknown, fallback: JoinErrorCode): JoinError {
  if (error instanceof JoinError) return error;
  const message = joinErrorMessage(error, fallback);
  if (message === NODE_REVOKED_REJOIN_ERROR || /\bnode_revoked\b/.test(message)) {
    return new JoinError('node_revoked', NODE_REVOKED_REJOIN_ERROR);
  }
  if (/\bnode_exists\b/.test(message)) {
    return new JoinError('node_exists', message);
  }
  return new JoinError(fallback, message);
}

function injectRedeemPop(fetcher: HubFetch | undefined, pop: string): HubFetch {
  const inner = fetcher ?? fetch;
  const withPop: HubFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let next = init;
    if (url.includes('/api/hub/enrollments/redeem') && typeof init?.body === 'string') {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      parsed.pop = pop;
      next = { ...init, body: JSON.stringify(parsed) };
    }
    return inner(input, next);
  };
  return withPop;
}

function pinHubCa(inner: HubFetch, pem: string): HubFetch {
  return (input, init) => inner(input, { ...init, tls: { ca: [pem] } });
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function errorHaystack(error: unknown): string {
  const parts = [errorCode(error)];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' ').toLowerCase();
}

function isTlsVerifyError(error: unknown): boolean {
  const haystack = errorHaystack(error);
  return /unable_to_verify|unable to verify|self[- ]signed|depth_zero|err_tls|err_cert|certificate|hostname|altname|cert_has_expired|unable_to_get_issuer|tls handshake|ssl/.test(
    haystack
  );
}

function authModeJoinError(error: unknown, pinned: boolean): JoinError {
  const cause = joinErrorMessage(error, 'unable to resolve hub uid from GET /api/auth/mode');
  const prefix = 'unable to resolve hub uid from GET /api/auth/mode';
  if (isTlsVerifyError(error)) {
    const hint = pinned
      ? 'Check the pinned CA and hub hostname.'
      : 'This hub may be using a self-signed certificate; generate a v2 join token from the hub.';
    return new JoinError(
      'hub_unreachable',
      `${prefix}: TLS verification failed (${cause}). ${hint}`
    );
  }
  if (isNetworkFetchError(error)) {
    return new JoinError('hub_unreachable', `${prefix}: network error (${cause})`);
  }
  return new JoinError('hub_unreachable', `${prefix}: ${cause}`);
}

async function fetchPinnedHubCa(
  hubUrl: string,
  fingerprint: string,
  fetcher: HubFetch
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(`${hubUrl}/api/tls/ca.crt`, {
      redirect: 'error',
      tls: { rejectUnauthorized: false },
    } as RequestInit);
  } catch (error) {
    throw new JoinError(
      isNetworkFetchError(error) ? 'hub_unreachable' : 'join_failed',
      joinErrorMessage(error, 'ca_unavailable')
    );
  }
  if (!response.ok) {
    throw new JoinError('join_failed', 'ca_unavailable');
  }
  let raw: string;
  try {
    raw = await readBoundedResponseText(response);
  } catch (error) {
    const message = joinErrorMessage(error, 'ca_unavailable');
    throw new JoinError(
      'join_failed',
      message === 'ca_response_too_large' ? 'ca_response_too_large' : 'ca_invalid'
    );
  }
  let parsed: Awaited<ReturnType<typeof parseAndValidateCaPem>>;
  try {
    parsed = await parseAndValidateCaPem(raw);
  } catch {
    throw new JoinError('join_failed', 'ca_invalid');
  }
  if (parsed.fingerprint !== fingerprint) {
    throw new JoinError('join_failed', 'ca_fingerprint_mismatch');
  }
  return parsed.canonicalPem;
}

function log(io: HubIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

function nowMs(io?: HubIo): number {
  return io?.now?.() ?? Date.now();
}

async function writeRolesAndHubUrl(envPath: string, roles: string, hubUrl: string): Promise<void> {
  await withEnvLock(async () => {
    const env = await readEnvFile(envPath);
    env.TMEX_ROLES = roles;
    env.TMEX_HUB_URL = hubUrl;
    if (roles === 'node') {
      env.TMEX_HUB_PUBLIC_URL = '';
    }
    await writeEnvFile(envPath, env);
  });
}

async function resolveServiceName(parsed: ParsedArgs, installDir: string): Promise<string> {
  let serviceName = asString(parsed.flags['service-name']) || 'tmex';
  if (!installDir) return serviceName;
  const layout = createInstallLayout(installDir);
  if (await pathExists(layout.metaPath)) {
    const meta = await readJsonFile<InstallMeta>(layout.metaPath);
    serviceName = meta.serviceName;
  }
  return serviceName;
}

export async function maybeRestart(
  parsed: ParsedArgs,
  io: HubIo | undefined,
  installDir: string
): Promise<void> {
  if (parsed.flags['no-restart'] === true) {
    log(io, HUB_MANUAL_RESTART_HINT);
    return;
  }
  if (io?.restart) {
    const serviceName = await resolveServiceName(parsed, installDir);
    await io.restart(serviceName, installDir);
    return;
  }
  if (io?.skipRestart) return;
  const manager = io?.serviceManager ?? (await detectServiceManager());
  if (manager === 'none') {
    log(io, HUB_MANUAL_RESTART_HINT);
    return;
  }
  const serviceName = await resolveServiceName(parsed, installDir);
  await restartService(serviceName, installDir);
}

async function maybeStop(
  parsed: ParsedArgs,
  io: HubIo | undefined,
  installDir: string,
  skipIfAuth = false
): Promise<void> {
  const stop = io?.stop ?? (io?.skipRestart || (skipIfAuth && io?.auth) ? undefined : stopService);
  if (!stop) return;
  await stop(await resolveServiceName(parsed, installDir), installDir);
}

async function maybeStart(
  parsed: ParsedArgs,
  io: HubIo | undefined,
  installDir: string
): Promise<void> {
  const start = io?.start ?? (io?.skipRestart || io?.auth ? undefined : startService);
  if (!start) return;
  await start(await resolveServiceName(parsed, installDir), installDir);
}

async function resolveLeaveServicePlan(
  io: HubIo | undefined,
  installDir: string
): Promise<{ manage: boolean }> {
  if (!installDir || io?.skipRestart) return { manage: false };
  const manager = io?.serviceManager ?? (await detectServiceManager());
  return { manage: manager !== 'none' };
}

export async function runHubUserAdd(
  parsed: ParsedArgs,
  username: string,
  io: HubIo = {}
): Promise<{ userId: string; fingerprint: string; rootEpoch: number }> {
  if (!username) {
    throw new Error('hub user add requires <username>');
  }
  const password = await resolvePassword({
    password: io.password,
    confirm: io.password === undefined,
    prompt: 'New password',
    confirmPrompt: 'Confirm password',
  });
  return await withAuth(parsed, io, async (ctx) => {
    if (ctx.userStore.getByUsername(username)) {
      throw new Error(`user already exists: ${username} (use mesh reset-root to replace the root)`);
    }
    const identity = await ensureNodeIdentity(ctx.identityStore);
    const boot = await ctx.userKeys.bootstrapUserWithSelfAdmit({
      username,
      password,
      identity,
      now: nowMs(io),
    });
    const fingerprint = fingerprintPublicKey(boot.rootPublicKey);
    log(io, `user ${username} created`);
    log(io, `root public key fingerprint: ${fingerprint}`);
    return { userId: boot.userId, fingerprint, rootEpoch: boot.rootEpoch };
  });
}

export async function runHubUserPasswd(
  parsed: ParsedArgs,
  username: string,
  io: HubIo = {}
): Promise<{ rootEpoch: number; mode: 'keep' | 'full-reset' }> {
  if (!username) {
    throw new Error('hub user passwd requires <username>');
  }
  return await withAuth(parsed, io, (ctx) => applyHubUserPasswd(parsed, username, ctx, io));
}

export async function runHubUserTotp(
  parsed: ParsedArgs,
  username: string,
  io: HubIo = {}
): Promise<{ uri: string; secret: Uint8Array }> {
  if (!username) {
    throw new Error('hub user totp requires <username>');
  }
  const password = await resolvePassword({
    password: io.password,
    confirm: false,
    prompt: 'Password',
  });
  return await withAuth(parsed, io, async (ctx) => {
    const user = ctx.userStore.getByUsername(username);
    if (!user) {
      throw new Error(`user not found: ${username}`);
    }
    const rootKey = await deriveRootKey(password, kdfParamsFromJson(user.kdfParamsJson));
    assertRootKeyMatches(rootKey, user.rootPublicKey);
    const secret = randomBytes(20);
    const seq = BigInt(user.keyLogHeadSeq + 1);
    const kTotp = deriveTotpKey(rootKey.seed, user.id, user.rootEpoch);
    const payload = await encryptTotpSecret(kTotp, secret, {
      uid: user.id,
      root_epoch: user.rootEpoch,
      seq,
    });
    const applied = await ctx.userKeys.signAndApply(user.id, rootKey, {
      type: 'set-totp',
      payload: encodeSetTotpPayload(payload),
    });
    if (!applied.ok) {
      throw new Error(`set-totp failed: ${applied.error}`);
    }
    const uri = totpOtpauthUri(username, secret);
    log(io, `TOTP enrolled for ${username}`);
    log(io, uri);
    return { uri, secret };
  });
}

export async function runHubUserReset(
  parsed: ParsedArgs,
  io: HubIo = {}
): Promise<{ wiped: number }> {
  return await withAuth(parsed, io, async (ctx) => {
    await maybeStop(parsed, io, ctx.installDir);
    const rows = ctx.db.select().from(nodes).all();
    ctx.db.delete(nodes).run();
    ctx.db.delete(enrollmentTokens).run();
    log(io, 'hub registry reset (nodes and enrollment tokens wiped)');
    log(io, 'node_certs kept; revoke compromised nodes with revoke-node before they re-register');
    await maybeRestart(parsed, io, ctx.installDir);
    return { wiped: rows.length };
  });
}

async function prepareHubJoin(input: PerformHubJoinInput, deps: PerformHubJoinDeps) {
  let decoded: ReturnType<typeof decodeJoinToken>;
  try {
    decoded = decodeJoinToken(input.token);
  } catch (error) {
    throw new JoinError('invalid_token', joinErrorMessage(error, 'invalid join token'));
  }
  let hubUrl: string;
  try {
    hubUrl = canonicalHubUrl(
      assertHubJoinUrl(
        input.hubUrl,
        input.insecureLocal === true,
        input.nodeEnv ?? process.env.NODE_ENV
      ).toString()
    );
  } catch (error) {
    throw new JoinError('invalid_url', joinErrorMessage(error, 'invalid hub url'));
  }
  const identity = await ensureNodeIdentity(deps.auth.identityStore);
  const baseFetcher: HubFetch = deps.fetcher ?? fetch;
  let pinnedPem: string | null = null;
  let hubFetcher = baseFetcher;
  if (decoded.caFingerprint) {
    pinnedPem = await fetchPinnedHubCa(hubUrl, decoded.caFingerprint, baseFetcher);
    hubFetcher = pinHubCa(baseFetcher, pinnedPem);
  }
  let uid: string | null = null;
  try {
    uid = (await fetchAuthMode(hubUrl, hubFetcher)).uid;
  } catch (error) {
    throw authModeJoinError(error, Boolean(decoded.caFingerprint));
  }
  if (!uid) {
    throw new JoinError('hub_unreachable', 'unable to resolve hub uid from GET /api/auth/mode');
  }
  return { decoded, hubUrl, identity, hubFetcher, pinnedPem, uid };
}

export async function performHubJoin(
  input: PerformHubJoinInput,
  deps: PerformHubJoinDeps
): Promise<{ userId: string; username: string; hubUrl: string; replacedStaleUsername?: string }> {
  const { decoded, hubUrl, identity, hubFetcher, pinnedPem, uid } = await prepareHubJoin(
    input,
    deps
  );
  const enrollPkResolved = rootKeyFromSeed(decoded.enrollSk).publicKey;
  const cert = createNodeCertificate(decoded.enrollSk, {
    uid,
    edPk: identity.edPublicKey,
    x25519Pk: identity.x25519PublicKey,
    enrollPk: enrollPkResolved,
    now: deps.now?.() ?? Date.now(),
    nodeId: identity.nodeId,
  });
  const pop = encodeBase64url(
    signEd25519(
      identity.edPrivateKey,
      encodeRedeemPopMessage({
        enrollmentId: encodeBase64url(enrollPkResolved),
        nodeId: identity.nodeId,
        certBytes: cert.certificateBytes,
      })
    )
  );
  let redeemed: RedeemResponse;
  try {
    redeemed = await redeemEnrollment({
      baseUrl: hubUrl,
      certificate: cert.certificateBytes,
      certSig: cert.certSig,
      name: input.name,
      fetcher: injectRedeemPop(hubFetcher, pop),
    });
  } catch (error) {
    throw toJoinError(error, isNetworkFetchError(error) ? 'hub_unreachable' : 'join_failed');
  }
  let admittedCert: { certificateBytes: Uint8Array; certSig: Uint8Array } | null;
  try {
    admittedCert = assertJoinCertReusable(
      redeemed,
      identity.nodeIdHex,
      identity.edPublicKey,
      identity.x25519PublicKey
    );
  } catch (error) {
    throw toJoinError(error, 'join_failed');
  }
  let committed: { replacedStaleUsername?: string };
  try {
    committed = await commitVerifiedJoin(deps.auth, {
      redeemed,
      expectedRootPublicKey: decoded.rootPublicKey,
      anchorHash: decoded.keyLogHeadHash,
      certificateBytes: admittedCert?.certificateBytes ?? cert.certificateBytes,
      hubUrl,
      identity,
      admittedCert,
    });
  } catch (error) {
    throw toJoinError(error, 'join_failed');
  }
  if (pinnedPem && decoded.caFingerprint) {
    new HubTrustStore(deps.auth.db).put({
      hubUrl,
      caPem: pinnedPem,
      fingerprint: decoded.caFingerprint,
    });
  }
  return {
    userId: redeemed.user.id,
    username: redeemed.user.username || redeemed.user.id,
    hubUrl,
    ...(committed.replacedStaleUsername
      ? { replacedStaleUsername: committed.replacedStaleUsername }
      : {}),
  };
}

export async function runHubJoin(
  parsed: ParsedArgs,
  urlRaw: string,
  io: HubIo = {}
): Promise<{
  userId: string;
  hubUrl: string;
}> {
  const tokenFlag = asString(parsed.flags.token);
  if (tokenFlag && parsed.flags.password !== undefined) {
    throw new Error('hub join --token and --password are mutually exclusive');
  }
  if (!tokenFlag && parsed.flags.password === undefined) {
    throw new Error('hub join requires --token or --password');
  }
  if (tokenFlag && isRelayJoinToken(tokenFlag)) {
    const { runRelayJoin } = await import('./relay-join');
    const relay = await runRelayJoin(parsed, urlRaw, tokenFlag, io);
    return { userId: relay.userId, hubUrl: relay.relayUrl };
  }
  if (!urlRaw) {
    throw new Error('hub join requires <https-url>');
  }
  const insecureLocal = parsed.flags['insecure-local'] === true || io.insecureLocal === true;
  const name = asString(parsed.flags.name) || 'node';
  let token = tokenFlag;
  let passwordRootKey: RootKey | undefined;
  if (!token) {
    const material = await requestEnrollmentByPassword({
      hubUrl: urlRaw,
      password: await resolvePassword({
        password: asString(parsed.flags.password),
      }),
      fetcher: io.fetcher,
      insecureLocal,
      nodeEnv: io.nodeEnv ?? process.env.NODE_ENV,
      now: io.now,
    });
    token = material.token;
    passwordRootKey = material.rootKey;
  }
  if (!token) {
    throw new Error('hub join requires --token or --password');
  }

  return await withAuth(parsed, io, async (ctx) => {
    try {
      const joined = await performHubJoin(
        {
          hubUrl: urlRaw,
          token,
          name,
          insecureLocal,
          nodeEnv: io.nodeEnv ?? process.env.NODE_ENV,
        },
        {
          auth: ctx,
          now: io.now,
          fetcher: io.fetcher,
        }
      );
      if (passwordRootKey) {
        await publishHubJoinSelfAdmit({
          auth: ctx,
          hubUrl: joined.hubUrl,
          userId: joined.userId,
          rootKey: passwordRootKey,
          fetcher: io.fetcher,
          now: io.now,
        });
      }
      if (joined.replacedStaleUsername) {
        log(io, t('hub.join.replacedStale', { username: joined.replacedStaleUsername }));
      }

      const currentRoles = parseTmexRoles(ctx.env.TMEX_ROLES ?? process.env.TMEX_ROLES);
      const nextRole = currentRoles.hub ? 'hub,node' : 'node';
      if (ctx.envPath) {
        await writeRolesAndHubUrl(ctx.envPath, nextRole, joined.hubUrl);
      } else {
        process.env.TMEX_ROLES = nextRole;
        process.env.TMEX_HUB_URL = joined.hubUrl;
        if (nextRole === 'node') {
          process.env.TMEX_HUB_PUBLIC_URL = '';
        }
      }
      if (ctx.installDir) {
        await maybeRestart(parsed, io, ctx.installDir);
      }
      log(io, `joined hub ${joined.hubUrl}`);
      const peerPort =
        ctx.env.TMEX_PEER_PORT || process.env.TMEX_PEER_PORT || String(DEFAULT_PEER_PORT);
      log(io, `allow inbound TMEX_PEER_PORT (${peerPort}) on the LAN firewall for direct links`);
      return { userId: joined.userId, hubUrl: joined.hubUrl };
    } finally {
      wipeRootKey(passwordRootKey);
    }
  });
}

function assertJoinCertReusable(
  redeemed: RedeemResponse,
  nodeIdHex: string,
  edPk: Uint8Array,
  x25519Pk: Uint8Array
): { certificateBytes: Uint8Array; certSig: Uint8Array } | null {
  const row = redeemed.node_certs.find((cert) => cert.node_id === nodeIdHex);
  if (!row) return null;
  if (row.revoked_log_seq != null) {
    throw new Error(NODE_REVOKED_REJOIN_ERROR);
  }
  const certificateBytes = decodeBase64url(row.certificate);
  const decoded = decodeCertificate(certificateBytes);
  if (!bytesEqual(decoded.ed_pk, edPk) || !bytesEqual(decoded.x25519_pk, x25519Pk)) {
    throw new Error(
      'join identity mismatch: Ed25519/X25519 public keys do not match this node identity'
    );
  }
  return { certificateBytes, certSig: decodeBase64url(row.cert_sig) };
}

async function commitVerifiedJoin(
  ctx: LocalAuthContext,
  input: {
    redeemed: RedeemResponse;
    expectedRootPublicKey: Uint8Array;
    anchorHash: Uint8Array;
    certificateBytes: Uint8Array;
    hubUrl: string;
    identity: Awaited<ReturnType<typeof ensureNodeIdentity>>;
    admittedCert: { certificateBytes: Uint8Array; certSig: Uint8Array } | null;
  }
): Promise<{ replacedStaleUsername?: string }> {
  const records = input.redeemed.user_key_log.map((item) => ({
    bytes: decodeBase64url(item.bytes),
    sig: decodeBase64url(item.sig),
  }));
  // 链上可能有 passkey 签名的记录，而本机此刻还没有这个用户（UserStore 里没有凭据），
  // 只能用链自身投影出来的凭据表验签；`commitJoin` 内部会再回放一遍，同样需要它。
  const verifyPasskeyAssertion = makeReplayPasskeyVerifier(records);
  const preview = await verifyKeyLogChain(records, input.expectedRootPublicKey, undefined, {
    verifyPasskeyAssertion,
  });
  if (!preview.ok) {
    throw new Error(`key log rejected: ${preview.error}`);
  }
  let genesisUid: string;
  try {
    genesisUid = decodeKeyLogRecord(records[0]?.bytes ?? new Uint8Array()).uid;
  } catch {
    throw new Error('key log rejected: missing_genesis');
  }
  const certUid = decodeCertificate(input.certificateBytes).uid;
  if (certUid !== genesisUid || input.redeemed.user.id !== genesisUid) {
    throw new Error('join uid mismatch');
  }
  assertChainUids(records, genesisUid);
  assertResponseCertsMatchProjections(input.redeemed, preview.state, genesisUid);

  const loaded = await ctx.identityStore.load();
  const admitted = input.admittedCert;
  const committed = await joinUserKeyService(ctx, records).commitJoin({
    records,
    expectedRootPublicKey: input.expectedRootPublicKey,
    anchorHash: input.anchorHash,
    username: input.redeemed.user.username || genesisUid,
    expectedUserId: genesisUid,
    identity: {
      nodeId: input.identity.nodeIdHex,
      hubUrl: input.hubUrl,
      edPrivateKey: input.identity.edPrivateKey,
      x25519PrivateKey: input.identity.x25519PrivateKey,
      certificateJson: admitted
        ? JSON.stringify({
            x25519PublicKey: encodeBase64url(input.identity.x25519PublicKey),
            certificate: encodeBase64url(admitted.certificateBytes),
          })
        : (loaded?.certificateJson ??
          JSON.stringify({
            x25519PublicKey: encodeBase64url(input.identity.x25519PublicKey),
          })),
      certSig: admitted?.certSig ?? loaded?.certSig ?? new Uint8Array(0),
      userId: genesisUid,
    },
  });
  if (!committed.ok) {
    throw new Error(`key log rejected: ${committed.error}`);
  }
  const persisted = loaded ?? (await ctx.identityStore.load());
  if (persisted) {
    await ctx.identityStore.save({ ...persisted, userId: genesisUid, hubUrl: input.hubUrl });
  }
  return committed.replacedStaleUsername
    ? { replacedStaleUsername: committed.replacedStaleUsername }
    : {};
}

export async function runHubLeave(parsed: ParsedArgs, io: HubIo = {}): Promise<void> {
  let installDir = io.auth?.installDir ?? '';
  if (!installDir && !io.auth) {
    installDir = (await loadInstallEnv(parsed)).installDir;
  }
  const { manage } = await resolveLeaveServicePlan(io, installDir);
  let stopped = false;
  if (manage) {
    await maybeStop(parsed, io, installDir, true);
    stopped = true;
  }
  try {
    await withAuth(parsed, io, async (ctx) => {
      const { isLeavableRoleName, leaveMesh } = await import('../runtime/membership-reset');
      const { createSetupTransitionLock } = await import('../runtime/setup-service');
      const roles = await rolesForLeave(ctx);
      const fromRole = roleNameFromFlags(roles);
      await leaveMesh(
        { expectedRole: isLeavableRoleName(fromRole) ? fromRole : 'node' },
        {
          roles,
          nodeEnv: io.nodeEnv ?? process.env.NODE_ENV ?? 'test',
          auth: ctx,
          envPath: ctx.envPath,
          installDir: ctx.installDir,
          setupLock: createSetupTransitionLock(),
        }
      );
    });
  } catch (error) {
    if (stopped) {
      await maybeStart(parsed, io, installDir);
    }
    throw error;
  }
  if (stopped) {
    if (parsed.flags['no-restart'] === true) {
      log(io, HUB_MANUAL_RESTART_HINT);
    } else {
      await maybeStart(parsed, io, installDir);
    }
  } else if (!io.skipRestart) {
    log(io, HUB_MANUAL_RESTART_HINT);
  }
  log(io, 'left hub; role set to standalone');
}

async function rolesForLeave(ctx: LocalAuthContext): Promise<TmexRoles> {
  if (ctx.envPath) {
    try {
      const env = await readEnvFile(ctx.envPath);
      if (env.TMEX_ROLES) return parseTmexRoles(env.TMEX_ROLES);
    } catch {
      // fall through to process/ctx env
    }
  }
  return parseTmexRoles(process.env.TMEX_ROLES ?? ctx.env.TMEX_ROLES);
}

function ansiRed(message: string): string {
  return `\u001b[31m${message}\u001b[0m`;
}

function envHubMode(env: Record<string, string>): 'active' | 'standby' {
  return env.TMEX_HUB_MODE?.trim() === 'standby' ? 'standby' : 'active';
}

function isHubNodeInstall(env: Record<string, string>): boolean {
  const roles = parseTmexRoles(env.TMEX_ROLES);
  return roles.hub && roles.node;
}

function parsePriorityFlag(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 200;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(t('hub.standby.invalidPriority'));
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(t('hub.standby.invalidPriority'));
  }
  return value;
}

function parseEnvWriterEpoch(raw: string | undefined): number {
  const value = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

function normalizeHubPeerId(raw: string, missingKey: string, invalidKey: string): string {
  const id = raw.trim().toLowerCase();
  if (!id) throw new Error(t(missingKey));
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new Error(t(invalidKey, { nodeId: raw }));
  }
  return id;
}

function mergeHubPeerIds(existing: string[], added: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const id of added) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function formatPeerList(peers: string[]): string {
  return peers.length > 0 ? peers.join(',') : t('hub.peers.empty');
}

async function loadCommandEnv(ctx: LocalAuthContext): Promise<Record<string, string>> {
  if (ctx.envPath) {
    try {
      return await readEnvFile(ctx.envPath);
    } catch {
      // fall through to in-memory env
    }
  }
  return { ...ctx.env };
}

async function patchInstallEnv(
  ctx: LocalAuthContext,
  patch: Record<string, string>
): Promise<void> {
  if (!ctx.envPath) {
    Object.assign(ctx.env, patch);
    Object.assign(process.env, patch);
    return;
  }
  await withEnvLock(async () => {
    const env = await readEnvFile(ctx.envPath);
    await writeEnvFile(ctx.envPath, { ...env, ...patch });
  });
}

function findPrimaryHubNodeId(ctx: LocalAuthContext, selfId: string | null): string | null {
  const self = selfId?.trim().toLowerCase() || null;
  try {
    const rows = ctx.db.select().from(meshHubs).all() as Array<{
      hubNodeId: string;
      mode: string;
      writerEpoch: number;
      priority: number;
    }>;
    const writer = pickWriterHubId(rows);
    if (writer) {
      const id = writer.toLowerCase();
      if (id !== self && /^[0-9a-f]{32}$/.test(id)) return id;
    }
  } catch {
    /* mesh_hubs 可能尚未建表 */
  }
  try {
    const meta = ctx.userStore.getHubMeta();
    const id = meta?.nodeId?.trim().toLowerCase() ?? '';
    if (id && id !== self && /^[0-9a-f]{32}$/.test(id)) return id;
  } catch {
    /* peer_cache 哨兵缺失或不可读 */
  }
  return null;
}

export function pickWriterHubId(
  hubs: Array<{ hubNodeId: string; mode: string; writerEpoch: number; priority: number }>
): string | null {
  const actives = hubs.filter((hub) => hub.mode === 'active');
  if (actives.length === 0) return null;
  actives.sort((left, right) => {
    if (left.writerEpoch !== right.writerEpoch) return right.writerEpoch - left.writerEpoch;
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.hubNodeId < right.hubNodeId) return -1;
    if (left.hubNodeId > right.hubNodeId) return 1;
    return 0;
  });
  return actives[0]?.hubNodeId ?? null;
}

function readMeshHubRows(
  ctx: LocalAuthContext,
  opts: { peerIds: ReadonlySet<string>; selfId: string | null }
): HubListRow[] {
  const rows = ctx.db.select().from(meshHubs).all() as Array<{
    hubNodeId: string;
    publicUrl: string;
    name: string | null;
    mode: string;
    priority: number;
    writerEpoch: number;
    online: boolean;
    lastSeenAt: number | null;
  }>;
  const writerHubId = pickWriterHubId(rows);
  const selfId = opts.selfId?.toLowerCase() ?? null;
  const uid = resolveMeshUserId(ctx.userStore, { nodeId: selfId });
  const envPeers = envPeerSet(opts.peerIds);
  return rows.map((row) => {
    const source = resolveHubAuthorization({
      hubNodeId: row.hubNodeId,
      selfId,
      envPeers,
      signed: lookupSignedHubAuthorization(ctx.userStore, uid, row.hubNodeId),
    });
    const authorization = hubAuthListColumn(source);
    return {
      hubNodeId: row.hubNodeId,
      name: row.name,
      mode: row.mode === 'standby' ? 'standby' : 'active',
      priority: row.priority,
      writerEpoch: row.writerEpoch,
      publicUrl: row.publicUrl,
      online: Boolean(row.online),
      lastSeenAt: row.lastSeenAt,
      writer: row.hubNodeId === writerHubId,
      authorized: authorization !== 'no',
      authorization,
    };
  });
}

async function recordCliRoleTransition(
  ctx: LocalAuthContext,
  input: { mode: 'active' | 'standby'; writerEpoch: number | null }
): Promise<void> {
  try {
    const identity = await ctx.identityStore.load();
    const targetHubId = identity?.nodeId?.trim().toLowerCase() ?? '';
    if (!targetHubId) return;
    const now = Date.now();
    new HubRoleTransitionStore(ctx.db).insert({
      operationId: crypto.randomUUID(),
      targetHubId,
      mode: input.mode,
      writerEpoch: input.writerEpoch,
      phase: 'restarting',
      error: null,
      startedAt: now,
      updatedAt: now,
    });
  } catch {
    /* 旧库或无表时不挡 CLI */
  }
}

function maxMeshHubWriterEpoch(ctx: LocalAuthContext): number | null {
  try {
    const rows = ctx.db
      .select({ writerEpoch: meshHubs.writerEpoch })
      .from(meshHubs)
      .all() as Array<{
      writerEpoch: number;
    }>;
    if (!rows.length) return 0;
    return rows.reduce((max, row) => Math.max(max, row.writerEpoch ?? 0), 0);
  } catch {
    return null;
  }
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
}

function formatLastSeen(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '-';
  try {
    return new Date(value).toISOString();
  } catch {
    return '-';
  }
}

function formatHubList(rows: HubListRow[]): string[] {
  const lines = [t('hub.list.header')];
  for (const row of rows) {
    const short = row.hubNodeId.slice(0, 8);
    const mark = row.writer ? '*' : ' ';
    lines.push(
      [
        `${mark}${pad(short, 10)}`,
        pad(row.name ?? '-', 15),
        pad(row.mode, 8),
        pad(String(row.priority), 4),
        pad(String(row.writerEpoch), 6),
        pad(row.authorization, 6),
        pad(row.online ? 'yes' : 'no', 7),
        pad(formatLastSeen(row.lastSeenAt), 21),
        row.publicUrl,
      ].join(' ')
    );
  }
  return lines;
}

async function confirmPromote(parsed: ParsedArgs, io: HubIo | undefined): Promise<void> {
  if (parsed.flags.yes === true) return;
  if (io?.confirm) {
    const ok = await io.confirm();
    if (!ok) throw new Error(t('common.cancelled'));
    return;
  }
  if (!isInteractiveStdin() || parsed.flags['no-interactive'] === true) {
    throw new Error(t('hub.promote.needConfirm'));
  }
  const ok = await promptConfirm({ nonInteractive: false }, t('hub.promote.warning'), false);
  if (!ok) throw new Error(t('common.cancelled'));
}

export async function runHubStandby(
  parsed: ParsedArgs,
  io: HubIo = {}
): Promise<{ publicUrl: string; priority: number; nodeId: string }> {
  const publicUrlRaw = asString(parsed.flags['public-url']);
  if (!publicUrlRaw) {
    throw new Error(t('hub.standby.missingPublicUrl'));
  }
  const priority = parsePriorityFlag(asString(parsed.flags.priority));
  const insecureLocal = parsed.flags['insecure-local'] === true || io.insecureLocal === true;
  let publicUrl: string;
  try {
    publicUrl = canonicalHubUrl(
      assertHubJoinUrl(publicUrlRaw, insecureLocal, io.nodeEnv ?? process.env.NODE_ENV).toString()
    );
  } catch (error) {
    throw new Error(joinErrorMessage(error, t('hub.standby.missingPublicUrl')));
  }

  return await withAuth(parsed, io, async (ctx) => {
    const identity = await ctx.identityStore.load();
    if (!identity) {
      throw new Error(t('hub.standby.notJoined'));
    }
    const env = await loadCommandEnv(ctx);
    if (isHubNodeInstall(env) && envHubMode(env) === 'active') {
      throw new Error(t('hub.standby.alreadyActive'));
    }
    if (!env.TMEX_HUB_URL?.trim()) {
      throw new Error(t('hub.standby.missingHubUrl'));
    }
    const primaryId = findPrimaryHubNodeId(ctx, identity.nodeId);
    const peers = primaryId
      ? mergeHubPeerIds(parseHubPeerIds(env.TMEX_HUB_PEERS), [primaryId])
      : parseHubPeerIds(env.TMEX_HUB_PEERS);
    await patchInstallEnv(
      ctx,
      applyHubModeEnvKeys(env, {
        roles: 'hub,node',
        mode: 'standby',
        publicUrl,
        priority,
        ...(primaryId ? { hubPeers: peers } : {}),
      })
    );
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, t('hub.standby.done', { priority, url: publicUrl }));
    log(io, t('hub.standby.nodeId', { nodeId: identity.nodeId }));
    log(io, t('hub.standby.allowHint', { nodeId: identity.nodeId }));
    if (primaryId) {
      log(
        io,
        t('hub.standby.authorizedPrimary', { nodeId: primaryId, peers: formatPeerList(peers) })
      );
    } else {
      log(io, t('hub.standby.noPrimary'));
    }
    return { publicUrl, priority, nodeId: identity.nodeId };
  });
}

export async function runHubPromote(
  parsed: ParsedArgs,
  io: HubIo = {}
): Promise<{ writerEpoch: number }> {
  return await withAuth(parsed, io, async (ctx) => {
    const env = await loadCommandEnv(ctx);
    if (!isHubNodeInstall(env)) {
      throw new Error(t('hub.promote.notHub'));
    }
    log(io, ansiRed(t('hub.promote.warning')));
    await confirmPromote(parsed, io);
    const identity = await ctx.identityStore.load();
    const nodeId = identity?.nodeId ?? '';
    const peers = parseHubPeerIds(env.TMEX_HUB_PEERS);
    if (peers.length === 0) {
      log(io, ansiRed(t('hub.promote.emptyPeers', { nodeId })));
    }
    log(io, t('hub.promote.allowReminder', { nodeId }));
    const envEpoch = parseEnvWriterEpoch(env.TMEX_HUB_WRITER_EPOCH);
    const dbMax = maxMeshHubWriterEpoch(ctx);
    const writerEpoch = dbMax == null ? envEpoch + 1 : Math.max(envEpoch, dbMax) + 1;
    await patchInstallEnv(ctx, applyHubModeEnvKeys(env, { mode: 'active', writerEpoch }));
    await recordCliRoleTransition(ctx, { mode: 'active', writerEpoch });
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, t('hub.promote.done', { epoch: writerEpoch }));
    log(io, t('hub.peers.current', { peers: formatPeerList(peers) }));
    return { writerEpoch };
  });
}

export async function runHubDemote(parsed: ParsedArgs, io: HubIo = {}): Promise<void> {
  await withAuth(parsed, io, async (ctx) => {
    const env = await loadCommandEnv(ctx);
    if (!isHubNodeInstall(env)) {
      throw new Error(t('hub.demote.notHub'));
    }
    const peers = parseHubPeerIds(env.TMEX_HUB_PEERS);
    await patchInstallEnv(ctx, applyHubModeEnvKeys(env, { mode: 'standby' }));
    await recordCliRoleTransition(ctx, {
      mode: 'standby',
      writerEpoch: parseEnvWriterEpoch(env.TMEX_HUB_WRITER_EPOCH),
    });
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, t('hub.demote.done'));
    log(io, t('hub.peers.current', { peers: formatPeerList(peers) }));
  });
}

export async function runHubList(
  parsed: ParsedArgs,
  io: HubIo = {}
): Promise<{ hubs: HubListRow[]; writerHubId: string | null }> {
  return await withAuth(parsed, io, async (ctx) => {
    const env = await loadCommandEnv(ctx);
    const identity = await ctx.identityStore.load();
    const peerIds = new Set(parseHubPeerIds(env.TMEX_HUB_PEERS));
    let hubs: HubListRow[] = [];
    try {
      hubs = readMeshHubRows(ctx, {
        peerIds,
        selfId: identity?.nodeId ?? null,
      });
    } catch {
      hubs = [];
    }
    const writerHubId = pickWriterHubId(hubs);
    if (hubs.length === 0) {
      log(io, t('hub.list.empty'));
    } else {
      for (const line of formatHubList(hubs)) {
        log(io, line);
      }
    }
    try {
      const latest = new HubRoleTransitionStore(ctx.db).latest();
      if (latest) {
        log(io, `role-transition ${latest.phase} ${latest.operationId}`);
      }
    } catch {
      /* ignore */
    }
    return { hubs, writerHubId };
  });
}

export async function runHubAllow(
  parsed: ParsedArgs,
  nodeIds: string[],
  io: HubIo = {}
): Promise<{ peers: string[] }> {
  if (nodeIds.length === 0) {
    throw new Error(t('hub.allow.missingNodeId'));
  }
  const added = nodeIds.map((id) =>
    normalizeHubPeerId(id, 'hub.allow.missingNodeId', 'hub.allow.invalidNodeId')
  );
  return await withAuth(parsed, io, async (ctx) => {
    const env = await loadCommandEnv(ctx);
    if (!isHubNodeInstall(env)) {
      throw new Error(t('hub.allow.notHub'));
    }
    const peers = mergeHubPeerIds(parseHubPeerIds(env.TMEX_HUB_PEERS), added);
    await patchInstallEnv(ctx, applyHubModeEnvKeys(env, { hubPeers: peers }));
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, t('hub.allow.done', { peers: formatPeerList(peers) }));
    log(io, HUB_SIGNED_AUTH_PRECEDENCE_NOTE);
    return { peers };
  });
}

export async function runHubDisallow(
  parsed: ParsedArgs,
  nodeId: string,
  io: HubIo = {}
): Promise<{ peers: string[] }> {
  const drop = normalizeHubPeerId(
    nodeId,
    'hub.disallow.missingNodeId',
    'hub.disallow.invalidNodeId'
  );
  return await withAuth(parsed, io, async (ctx) => {
    const env = await loadCommandEnv(ctx);
    if (!isHubNodeInstall(env)) {
      throw new Error(t('hub.disallow.notHub'));
    }
    const peers = parseHubPeerIds(env.TMEX_HUB_PEERS).filter((id) => id !== drop);
    await patchInstallEnv(ctx, applyHubModeEnvKeys(env, { hubPeers: peers }));
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, t('hub.disallow.done', { peers: formatPeerList(peers) }));
    log(io, HUB_SIGNED_AUTH_PRECEDENCE_NOTE);
    return { peers };
  });
}

export { nodes, enrollmentTokens };
