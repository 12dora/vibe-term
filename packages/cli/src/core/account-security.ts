// 账号安全：改密 / TOTP / 删 passkey。与 GUI `account-security-actions.ts` 同一套 key-log。

import type { PasskeySummary } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  TOTP_DEFAULT_DIGITS,
  TOTP_DEFAULT_STEP,
  decodeBase32,
  decodeBase64url,
  decodeSetTotpPayload,
  deriveSeed,
  deriveTotpKey,
  encodeBase32,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeRemovePasskeyPayload,
  encodeRotateRootKeepPayload,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  encryptTotpSecret,
  generateKdfParams,
  randomBytes,
  rewrapTotpSecret,
  rootKeyFromSeed,
  verifyTotpCode,
} from '@vibeterm/shared/auth';
import type { AuthMode } from './auth';
import { fetchAuthMode } from './auth';
import type { CliContext } from './context';
import { AuthError, CliError } from './errors';
import {
  appendKeyLog,
  assertKeyLogAppended,
  deriveRootFromMode,
  keyLogHead,
  signRecord,
} from './nodes-keylog';

export function generateTotpSecret(): Uint8Array {
  return randomBytes(20);
}

export function buildOtpauthUri(input: {
  secret: Uint8Array;
  account: string;
  issuer?: string;
}): string {
  const issuer = input.issuer ?? 'VibeTerm';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: encodeBase32(input.secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DEFAULT_DIGITS),
    period: String(TOTP_DEFAULT_STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export async function totpPreview(
  ctx: CliContext,
  secret: Uint8Array
): Promise<{ otpauthUri: string; secretBase32: string; uid: string }> {
  const mode = await requireMeshMode(ctx);
  const uid = mode.uid as string;
  return {
    uid,
    secretBase32: encodeBase32(secret),
    otpauthUri: buildOtpauthUri({ secret, account: uid }),
  };
}

export function decodeTotpSecret(raw: string): Uint8Array {
  try {
    const secret = decodeBase32(raw.trim());
    if (secret.length < 10) throw new Error('too short');
    return secret;
  } catch {
    throw new AuthError('TOTP secret is not valid base32');
  }
}

async function requireMeshMode(ctx: CliContext): Promise<AuthMode> {
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  if (!mode || mode.mode !== 'mesh') {
    throw new CliError('this entry is not a mesh instance');
  }
  if (!mode.uid || !mode.kdfParams || mode.rootEpoch === null || mode.rootEpoch === undefined) {
    throw new CliError('auth mode is missing uid/kdf/rootEpoch; cannot sign');
  }
  return mode;
}

interface TotpRecord {
  record_seq: string | number;
  root_epoch: number;
  payload: string;
}

async function loadTotpRecord(ctx: CliContext): Promise<TotpRecord | null> {
  const response = await ctx.http.fetch(SELF_NODE_ID, '/api/auth/totp-record');
  if (response.status === 404) {
    let code = '';
    try {
      const payload = (await response.json()) as { code?: unknown };
      if (typeof payload.code === 'string') code = payload.code;
    } catch {
      // 非 JSON
    }
    if (code === 'TOTP_NOT_ENABLED') return null;
    throw new CliError(`failed to load TOTP record: ${code || 'HTTP_404'}`);
  }
  await ctx.http.assertOk(SELF_NODE_ID, response, '/api/auth/totp-record');
  const payload = (await response.json()) as Partial<TotpRecord>;
  if (
    (typeof payload.record_seq !== 'string' && typeof payload.record_seq !== 'number') ||
    typeof payload.root_epoch !== 'number' ||
    typeof payload.payload !== 'string'
  ) {
    throw new CliError('failed to load TOTP record: MALFORMED');
  }
  return {
    record_seq: payload.record_seq,
    root_epoch: payload.root_epoch,
    payload: payload.payload,
  };
}

async function totpForKeep(input: {
  ctx: CliContext;
  uid: string;
  totpEnabled: boolean;
  oldSeed: Uint8Array;
  newSeed: Uint8Array;
  rootEpoch: number;
  nextSeq: bigint;
}): Promise<ReturnType<typeof rewrapTotpSecret> | null> {
  if (!input.totpEnabled) return null;
  const record = await loadTotpRecord(input.ctx);
  if (!record) return null;
  return rewrapTotpSecret({
    uid: input.uid,
    oldSeed: input.oldSeed,
    newSeed: input.newSeed,
    rootEpoch: input.rootEpoch,
    totpRecordSeq: BigInt(record.record_seq),
    totp: decodeSetTotpPayload(decodeBase64url(record.payload)),
    nextSeq: input.nextSeq,
  });
}

export async function changeAccountPassword(
  ctx: CliContext,
  input: { fullReset: boolean; oldPassword: string; newPassword: string }
): Promise<unknown> {
  const mode = await requireMeshMode(ctx);
  const oldRoot = await deriveRootFromMode(mode, input.oldPassword);
  const newKdf = generateKdfParams();
  const newSeed = await deriveSeed(input.newPassword, newKdf);
  const newRoot = rootKeyFromSeed(newSeed);
  try {
    const head = await keyLogHead(ctx);
    const totp = input.fullReset
      ? null
      : await totpForKeep({
          ctx,
          uid: mode.uid as string,
          totpEnabled: mode.totpEnabled === true,
          oldSeed: oldRoot.seed,
          newSeed: newRoot.seed,
          rootEpoch: mode.rootEpoch as number,
          nextSeq: head.seq + 1n,
        });
    const type = input.fullReset ? 'rotate-root' : 'rotate-root-keep';
    const payload = input.fullReset
      ? encodeRotateRootPayload({
          root_public_key: newRoot.publicKey,
          kdf_params: newKdf,
        })
      : encodeRotateRootKeepPayload({
          root_public_key: newRoot.publicKey,
          kdf_params: newKdf,
          totp,
        });
    const signed = signRecord(oldRoot, head, mode, type, payload);
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertKeyLogAppended(result, input.fullReset ? 'rotate-root' : 'rotate-root-keep');
    return result;
  } finally {
    oldRoot.seed.fill(0);
    newRoot.seed.fill(0);
    newSeed.fill(0);
  }
}

export async function enableTotp(
  ctx: CliContext,
  input: { password: string; secret: Uint8Array; code: string; now?: number }
): Promise<{ result: unknown; otpauthUri: string; secretBase32: string }> {
  const mode = await requireMeshMode(ctx);
  const nowSec = input.now ?? Math.floor(Date.now() / 1000);
  if (!verifyTotpCode(input.secret, input.code.trim(), nowSec)) {
    throw new AuthError(
      'TOTP code is invalid',
      'check the authenticator clock and try a fresh code'
    );
  }
  const root = await deriveRootFromMode(mode, input.password);
  const kTotp = deriveTotpKey(root.seed, mode.uid as string, mode.rootEpoch as number);
  try {
    const head = await keyLogHead(ctx);
    const payload = await encryptTotpSecret(kTotp, input.secret, {
      uid: mode.uid as string,
      root_epoch: mode.rootEpoch as number,
      seq: head.seq + 1n,
    });
    const signed = signRecord(root, head, mode, 'set-totp', encodeSetTotpPayload(payload));
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertKeyLogAppended(result, 'set-totp');
    return {
      result,
      otpauthUri: buildOtpauthUri({ secret: input.secret, account: mode.uid as string }),
      secretBase32: encodeBase32(input.secret),
    };
  } finally {
    kTotp.fill(0);
    root.seed.fill(0);
  }
}

export async function disableTotp(ctx: CliContext, password: string): Promise<unknown> {
  const mode = await requireMeshMode(ctx);
  const root = await deriveRootFromMode(mode, password);
  try {
    const head = await keyLogHead(ctx);
    const signed = signRecord(root, head, mode, 'clear-totp', encodeClearTotpPayload());
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertKeyLogAppended(result, 'clear-totp');
    return result;
  } finally {
    root.seed.fill(0);
  }
}

export async function listPasskeys(ctx: CliContext): Promise<PasskeySummary[]> {
  const payload = await ctx.http.json<{ passkeys?: PasskeySummary[] }>(
    SELF_NODE_ID,
    'GET',
    '/api/auth/passkeys'
  );
  return payload.passkeys ?? [];
}

export async function removePasskey(
  ctx: CliContext,
  credentialId: string,
  password: string
): Promise<unknown> {
  const mode = await requireMeshMode(ctx);
  const root = await deriveRootFromMode(mode, password);
  try {
    const head = await keyLogHead(ctx);
    const signed = signRecord(
      root,
      head,
      mode,
      'remove-passkey',
      encodeRemovePasskeyPayload({ credential_id: credentialId })
    );
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertKeyLogAppended(result, 'remove-passkey');
    return result;
  } finally {
    root.seed.fill(0);
  }
}

export const PASSKEY_REGISTER_HINT =
  'passkey registration requires a browser WebAuthn ceremony; add a passkey in the web UI';
