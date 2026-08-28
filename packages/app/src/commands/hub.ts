import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import { enrollmentTokens, nodes } from '../../../../apps/gateway/src/db/schema';
import { encodeRedeemPopMessage } from '../../../../apps/gateway/src/hub/redeem-pop';
import {
  bytesEqual,
  createNodeCertificate,
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeBase64url,
  decodeCertificate,
  decodeJoinToken,
  decodeKeyLogRecord,
  deriveTotpKey,
  encodeBase64url,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  encryptTotpSecret,
  generateKdfParams,
  randomBytes,
  rootKeyFromSeed,
  signEd25519,
  verifyKeyLogChain,
} from '../../../shared/src/auth';
import { t } from '../i18n';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { pathExists } from '../lib/fs-utils';
import {
  type HubFetch,
  type RedeemResponse,
  assertHubJoinUrl,
  fetchAuthMode,
  redeemEnrollment,
} from '../lib/hub-client';
import { createInstallLayout } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import type { LocalAuthContext } from '../lib/local-auth';
import { openInstallAuth } from '../lib/local-auth';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from '../lib/password';
import { type ServiceManagerKind, detectServiceManager } from '../lib/platform';
import { DEFAULT_PEER_PORT, parseTmexRoles } from '../lib/roles';
import { restartService, stopService } from '../lib/service';
import { fingerprintPublicKey, totpOtpauthUri } from '../lib/totp-uri';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import type { InstallMeta } from '../types';

export type HubIo = {
  log?: (message: string) => void;
  password?: string;
  oldPassword?: string;
  newPassword?: string;
  restart?: (serviceName: string, installDir: string) => Promise<void>;
  auth?: LocalAuthContext;
  now?: () => number;
  fetcher?: typeof fetch;
  insecureLocal?: boolean;
  skipRestart?: boolean;
  stop?: (serviceName: string, installDir: string) => Promise<void>;
  nodeEnv?: string;
  totpCode?: string;
  serviceManager?: ServiceManagerKind;
};

export const HUB_MANUAL_RESTART_HINT =
  'skipped service restart; restart tmex manually to apply the change';

export const NODE_REVOKED_REJOIN_ERROR =
  'this node identity was revoked; use a fresh identity (mesh reset / re-init)';

function injectRedeemPop(fetcher: HubFetch | undefined, pop: string): HubFetch {
  const inner = fetcher ?? fetch;
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let next = init;
    if (url.includes('/api/hub/enrollments/redeem') && typeof init?.body === 'string') {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      parsed.pop = pop;
      next = { ...init, body: JSON.stringify(parsed) };
    }
    return inner(input, next);
  }) as HubFetch;
}

function log(io: HubIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

function nowMs(io?: HubIo): number {
  return io?.now?.() ?? Date.now();
}

async function withAuth<T>(
  parsed: ParsedArgs,
  io: HubIo | undefined,
  fn: (ctx: LocalAuthContext) => Promise<T>
): Promise<T> {
  if (io?.auth) {
    return await fn(io.auth);
  }
  const ctx = await openInstallAuth(parsed);
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

async function persistHubUrl(ctx: LocalAuthContext, hubUrl: string | null): Promise<void> {
  const loaded = await ctx.identityStore.load();
  if (!loaded) return;
  await ctx.identityStore.save({ ...loaded, hubUrl });
}

async function writeRolesAndHubUrl(envPath: string, roles: string, hubUrl: string): Promise<void> {
  const env = await readEnvFile(envPath);
  env.TMEX_ROLES = roles;
  env.TMEX_HUB_URL = hubUrl;
  await writeEnvFile(envPath, env);
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

async function maybeRestart(
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
  installDir: string
): Promise<void> {
  const stop = io?.stop ?? (io?.skipRestart ? undefined : stopService);
  if (!stop) return;
  const serviceName = await resolveServiceName(parsed, installDir);
  await stop(serviceName, installDir);
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
): Promise<{ rootEpoch: number }> {
  if (!username) {
    throw new Error('hub user passwd requires <username>');
  }
  return await withAuth(parsed, io, async (ctx) => {
    const user = ctx.userStore.getByUsername(username);
    if (!user) {
      throw new Error(`user not found: ${username}`);
    }
    const oldPassword = await resolvePassword({
      password: io.oldPassword,
      envKey: 'TMEX_PASSWORD_OLD',
      confirm: false,
      prompt: 'Current password',
    });
    const oldKey = await deriveRootKey(oldPassword, kdfParamsFromJson(user.kdfParamsJson));
    assertRootKeyMatches(oldKey, user.rootPublicKey);

    const newPassword = await resolvePassword({
      password: io.newPassword ?? io.password,
      envKey: 'TMEX_PASSWORD',
      confirm: io.newPassword === undefined && io.password === undefined,
      prompt: 'New password',
      confirmPrompt: 'Confirm new password',
    });
    const kdfParams = generateKdfParams();
    const newKey = await deriveRootKey(newPassword, kdfParams);
    const applied = await ctx.userKeys.signAndApply(user.id, oldKey, {
      type: 'rotate-root',
      payload: encodeRotateRootPayload({
        root_public_key: newKey.publicKey,
        kdf_params: kdfParams,
      }),
    });
    if (!applied.ok) {
      throw new Error(`rotate-root failed: ${applied.error}`);
    }
    const next = ctx.userStore.getById(user.id);
    log(io, `password updated for ${username}`);
    log(io, 'warning: all passkeys and TOTP were reset; re-register them on each node');
    return { rootEpoch: next?.rootEpoch ?? user.rootEpoch + 1 };
  });
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

export async function runHubJoin(
  parsed: ParsedArgs,
  urlRaw: string,
  io: HubIo = {}
): Promise<{
  userId: string;
  hubUrl: string;
}> {
  if (!urlRaw) {
    throw new Error('hub join requires <https-url>');
  }
  const token = asString(parsed.flags.token);
  if (!token) {
    throw new Error('hub join requires --token');
  }
  const insecureLocal = parsed.flags['insecure-local'] === true || io.insecureLocal === true;
  const hubUrl = assertHubJoinUrl(urlRaw, insecureLocal, io.nodeEnv ?? process.env.NODE_ENV)
    .toString()
    .replace(/\/+$/, '');
  const decoded = decodeJoinToken(token);
  const name = asString(parsed.flags.name) || 'node';

  return await withAuth(parsed, io, async (ctx) => {
    const identity = await ensureNodeIdentity(ctx.identityStore);
    let uid: string | null = null;
    try {
      const mode = await fetchAuthMode(hubUrl, io.fetcher);
      uid = mode.uid;
    } catch {
      uid = null;
    }
    if (!uid) {
      throw new Error('unable to resolve hub uid from GET /api/auth/mode');
    }
    const enrollPkResolved = rootKeyFromSeed(decoded.enrollSk).publicKey;

    const cert = createNodeCertificate(decoded.enrollSk, {
      uid,
      edPk: identity.edPublicKey,
      x25519Pk: identity.x25519PublicKey,
      enrollPk: enrollPkResolved,
      now: nowMs(io),
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
        name,
        fetcher: injectRedeemPop(io.fetcher, pop),
      });
    } catch (error) {
      if (error instanceof Error && /\bnode_revoked\b/.test(error.message)) {
        throw new Error(NODE_REVOKED_REJOIN_ERROR);
      }
      throw error;
    }
    const admittedCert = assertJoinCertReusable(
      redeemed,
      identity.nodeIdHex,
      identity.edPublicKey,
      identity.x25519PublicKey
    );
    const committed = await commitVerifiedJoin(ctx, {
      redeemed,
      expectedRootPublicKey: decoded.rootPublicKey,
      anchorHash: decoded.keyLogHeadHash,
      certificateBytes: admittedCert?.certificateBytes ?? cert.certificateBytes,
      hubUrl,
      identity,
      admittedCert,
    });
    if (committed.replacedStaleUsername) {
      log(io, t('hub.join.replacedStale', { username: committed.replacedStaleUsername }));
    }

    const currentRoles = parseTmexRoles(ctx.env.TMEX_ROLES ?? process.env.TMEX_ROLES);
    const nextRole = currentRoles.hub ? 'hub,node' : 'node';
    if (ctx.envPath) {
      await writeRolesAndHubUrl(ctx.envPath, nextRole, hubUrl);
    } else {
      process.env.TMEX_ROLES = nextRole;
      process.env.TMEX_HUB_URL = hubUrl;
    }
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, `joined hub ${hubUrl}`);
    const peerPort =
      ctx.env.TMEX_PEER_PORT || process.env.TMEX_PEER_PORT || String(DEFAULT_PEER_PORT);
    log(io, `allow inbound TMEX_PEER_PORT (${peerPort}) on the LAN firewall for direct links`);
    return { userId: redeemed.user.id, hubUrl };
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
  const preview = await verifyKeyLogChain(records, input.expectedRootPublicKey);
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
  const committed = await ctx.userKeys.commitJoin({
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

function assertChainUids(records: Array<{ bytes: Uint8Array }>, genesisUid: string): void {
  for (const item of records) {
    const decoded = decodeKeyLogRecord(item.bytes);
    if (decoded.uid !== genesisUid) {
      throw new Error('join uid mismatch');
    }
    if (decoded.type !== 'admit-node') continue;
    const payload = decodeAdmitNodePayload(decoded.payload);
    const authorization = decodeAuthorization(payload.authorization_bytes);
    const certificate = decodeCertificate(payload.certificate_bytes);
    if (authorization.uid !== genesisUid || certificate.uid !== genesisUid) {
      throw new Error('join uid mismatch');
    }
  }
}

function assertResponseCertsMatchProjections(
  redeemed: RedeemResponse,
  state: {
    nodeCerts: Map<
      string,
      {
        certificateBytes: Uint8Array;
        certSig: Uint8Array;
        authorizationBytes: Uint8Array;
        authorizationSig: Uint8Array;
        revoked: boolean;
      }
    >;
  },
  userId: string
): void {
  if (redeemed.node_certs.length === 0) return;
  if (redeemed.node_certs.length !== state.nodeCerts.size) {
    throw new Error('node_certs mismatch');
  }
  for (const cert of redeemed.node_certs) {
    const projected = state.nodeCerts.get(cert.node_id);
    if (!projected) {
      throw new Error('node_certs mismatch');
    }
    if ((cert.user_id || userId) !== userId) {
      throw new Error('node_certs mismatch');
    }
    if (!bytesEqual(decodeBase64url(cert.certificate), projected.certificateBytes)) {
      throw new Error('node_certs mismatch');
    }
    if (!bytesEqual(decodeBase64url(cert.cert_sig), projected.certSig)) {
      throw new Error('node_certs mismatch');
    }
    if (!bytesEqual(decodeBase64url(cert.authorization), projected.authorizationBytes)) {
      throw new Error('node_certs mismatch');
    }
    if (!bytesEqual(decodeBase64url(cert.authorization_sig), projected.authorizationSig)) {
      throw new Error('node_certs mismatch');
    }
    const revoked = cert.revoked_log_seq != null;
    if (revoked !== projected.revoked) {
      throw new Error('node_certs mismatch');
    }
  }
}

export async function runHubLeave(parsed: ParsedArgs, io: HubIo = {}): Promise<void> {
  await withAuth(parsed, io, async (ctx) => {
    await persistHubUrl(ctx, null);
    if (ctx.envPath) {
      await writeRolesAndHubUrl(ctx.envPath, 'standalone', '');
    } else {
      process.env.TMEX_ROLES = 'standalone';
      process.env.TMEX_HUB_URL = '';
    }
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, 'left hub; role set to standalone');
  });
}

export { nodes, enrollmentTokens };
