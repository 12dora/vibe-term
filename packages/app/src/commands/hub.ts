import {
  ensureNodeIdentity,
  selfSignedNodeCertificate,
} from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import { enrollmentTokens, nodes } from '../../../../apps/gateway/src/db/schema';
import {
  bytesEqual,
  createNodeCertificate,
  decodeBase64url,
  decodeJoinToken,
  deriveTotpKey,
  encodeAdmitNodePayload,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  encryptTotpSecret,
  generateKdfParams,
  randomBytes,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { pathExists } from '../lib/fs-utils';
import {
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
import { DEFAULT_PEER_PORT, parseTmexRoles } from '../lib/roles';
import { restartService } from '../lib/service';
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
};

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

async function maybeRestart(
  parsed: ParsedArgs,
  io: HubIo | undefined,
  installDir: string
): Promise<void> {
  if (io?.skipRestart) return;
  const layout = createInstallLayout(installDir);
  let serviceName = asString(parsed.flags['service-name']) || 'tmex';
  if (await pathExists(layout.metaPath)) {
    const meta = await readJsonFile<InstallMeta>(layout.metaPath);
    serviceName = meta.serviceName;
  }
  const restart = io?.restart ?? restartService;
  await restart(serviceName, installDir);
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
    const boot = await ctx.userKeys.bootstrapUser({ username, password });
    const identity = await ensureNodeIdentity(ctx.identityStore);
    const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
      uid: boot.userId,
      rootEpoch: boot.rootEpoch,
      now: nowMs(io),
    });
    const applied = await ctx.userKeys.signAndApply(boot.userId, boot.rootKey, {
      type: 'admit-node',
      payload: encodeAdmitNodePayload(admit),
    });
    if (!applied.ok) {
      throw new Error(`admit-node failed: ${applied.error}`);
    }
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
    const rows = ctx.db.select().from(nodes).all();
    ctx.db.delete(nodes).run();
    ctx.db.delete(enrollmentTokens).run();
    log(io, 'hub registry reset (nodes and enrollment tokens wiped)');
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
  const hubUrl = assertHubJoinUrl(urlRaw, insecureLocal).toString().replace(/\/+$/, '');
  const decoded = decodeJoinToken(token);
  const name = asString(parsed.flags.name) || 'node';

  return await withAuth(parsed, io, async (ctx) => {
    const identity = await ensureNodeIdentity(ctx.identityStore, { hubUrl });
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

    const redeemed = await redeemEnrollment({
      baseUrl: hubUrl,
      certificate: cert.certificateBytes,
      certSig: cert.certSig,
      name,
      fetcher: io.fetcher,
    });
    await applyJoinPayload(ctx, redeemed, decoded.rootPublicKey, decoded.keyLogHeadHash);

    const currentRoles = parseTmexRoles(ctx.env.TMEX_ROLES ?? process.env.TMEX_ROLES);
    const nextRole = currentRoles.hub ? 'hub,node' : 'node';
    if (ctx.envPath) {
      await writeRolesAndHubUrl(ctx.envPath, nextRole, hubUrl);
    } else {
      process.env.TMEX_ROLES = nextRole;
      process.env.TMEX_HUB_URL = hubUrl;
    }
    await persistHubUrl(ctx, hubUrl);
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

async function applyJoinPayload(
  ctx: LocalAuthContext,
  redeemed: RedeemResponse,
  expectedRootPublicKey: Uint8Array,
  expectedHeadHash: Uint8Array
): Promise<void> {
  const records = redeemed.user_key_log.map((item) => ({
    bytes: decodeBase64url(item.bytes),
    sig: decodeBase64url(item.sig),
  }));
  const verified = await ctx.userKeys.verifyChainForJoin(
    records,
    expectedRootPublicKey,
    expectedHeadHash
  );
  if (!verified.ok) {
    throw new Error(`key log rejected: ${verified.error}`);
  }
  if (!bytesEqual(verified.state.rootPublicKey, expectedRootPublicKey)) {
    throw new Error('key log rejected: root mismatch');
  }
  const userId = redeemed.user.id;
  for (const cert of redeemed.node_certs) {
    ctx.userStore.upsertCert({
      nodeId: cert.node_id,
      userId: cert.user_id || userId,
      admitRecordSeq: cert.admit_record_seq,
      certificateBytes: decodeBase64url(cert.certificate),
      certSig: decodeBase64url(cert.cert_sig),
      authorizationBytes: decodeBase64url(cert.authorization),
      authorizationSig: decodeBase64url(cert.authorization_sig),
      revokedLogSeq: cert.revoked_log_seq,
    });
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
