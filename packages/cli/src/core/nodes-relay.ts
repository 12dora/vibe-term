// 中继租户侧：探测 uplink 形态、签 `meta-key`、用 r3. 加入码建 enrollment。

import { X509Certificate, createHash } from 'node:crypto';
import { NODE_ID_PATTERN, SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  type RootKey,
  createEnrollment,
  decodeBase64url,
  encodeBase64url,
} from '@vibeterm/shared/auth';
import {
  type RelayStatusRow as RelayStatusRowDto,
  type RelayUplinkMode,
  encodeRelayJoinToken,
} from '@vibeterm/shared/relay';
import type { FlagValues } from './args';
import { flagStrings } from './args';
import type { AuthMode } from './auth';
import type { CliContext } from './context';
import { CliError, NotFoundError } from './errors';
import { type AdminNode, findAdminNode, isTrustedHubUrl, joinCommand } from './nodes-hub';
import {
  type CreatedEnrollmentResult,
  type KeyLogAppendResult,
  appendKeyLog,
  assertKeyLogAppended,
  keyLogHead,
  signRecord,
  withRootKey,
} from './nodes-keylog';

export type { RelayUplinkMode };

/** 读侧宽松：旧节点 JSON 可能缺字段；`caFingerprint` 是 CLI 回退钉扎用的额外键。 */
export type RelayStatusRow = Partial<RelayStatusRowDto> & {
  url: string;
  caFingerprint?: string | null;
};

export interface RelayStatusJson {
  mode?: RelayUplinkMode | string;
  relays?: RelayStatusRow[];
  metaEpoch?: number;
  caFingerprint?: string | null;
}

export async function fetchRelayStatus(ctx: CliContext): Promise<RelayStatusJson | null> {
  const response = await ctx.http.fetch(SELF_NODE_ID, '/api/mesh/relay/status');
  if (response.status === 404) return null;
  await ctx.http.assertOk(SELF_NODE_ID, response, '/api/mesh/relay/status');
  return (await response.json()) as RelayStatusJson;
}

export function isRelayUplink(status: RelayStatusJson | null): boolean {
  return status?.mode === 'relay';
}

export async function detectRelayUplink(ctx: CliContext): Promise<boolean> {
  return isRelayUplink(await fetchRelayStatus(ctx));
}

export function attachedRelayUrl(status: RelayStatusJson | null): string | null {
  const rows = status?.relays ?? [];
  const attached = rows.find((row) => row.attached && row.url) ?? rows.find((row) => row.url);
  return attached?.url ?? null;
}

export type RelayMetaKeyOp =
  | { op: 'admit'; node_id: string }
  | { op: 'rotate'; exclude?: string[] };

export interface MetaKeyResult {
  op: 'admit' | 'rotate';
  epoch: number;
  seq: number | string;
}

interface PreparedMetaKey {
  payload: string;
  epoch?: number;
}

function seqOf(result: KeyLogAppendResult, headSeq: bigint): number | string {
  if (result.seq !== undefined) return result.seq;
  return (headSeq + 1n).toString();
}

export function assertRelayAck(result: KeyLogAppendResult, action: string): void {
  assertKeyLogAppended(result, action);
  if (result.relayAck === false) {
    throw new CliError(`${action} was not confirmed by relay (${result.relayError ?? 'no ack'})`);
  }
}

export async function appendRelayMetaKeyWithRoot(
  ctx: CliContext,
  root: RootKey,
  mode: AuthMode,
  op: RelayMetaKeyOp
): Promise<MetaKeyResult> {
  const prepared = await ctx.http.json<PreparedMetaKey>(
    SELF_NODE_ID,
    'POST',
    '/api/mesh/relay/meta-key/prepare',
    op
  );
  if (!prepared.payload) {
    throw new CliError('meta-key prepare did not return a payload');
  }
  const head = await keyLogHead(ctx);
  const signed = signRecord(root, head, mode, 'meta-key', decodeBase64url(prepared.payload));
  const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
  assertRelayAck(result, 'meta-key');
  return {
    op: op.op,
    epoch: prepared.epoch ?? 0,
    seq: seqOf(result, head.seq),
  };
}

export async function appendRelayMetaKey(
  ctx: CliContext,
  op: RelayMetaKeyOp
): Promise<MetaKeyResult> {
  return withRootKey(ctx, (root, mode) => appendRelayMetaKeyWithRoot(ctx, root, mode, op));
}

export async function resolveNodeHexId(ctx: CliContext, ref: string): Promise<string> {
  const trimmed = ref.trim();
  if (NODE_ID_PATTERN.test(trimmed)) return trimmed;
  return (await findAdminNode(ctx, trimmed)).id;
}

export async function resolveExcludeNodeIds(ctx: CliContext, flags: FlagValues): Promise<string[]> {
  const refs = flagStrings(flags, 'exclude').flatMap((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const id = await resolveNodeHexId(ctx, ref);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const JOIN_KEY_B64URL = /^[A-Za-z0-9_-]{43}$/;
const CA_FINGERPRINT_HEX = /^[0-9a-f]{64}$/;

interface JoinMaterialRelay {
  url: string;
  tenantId: string;
  token: string;
}

interface JoinMaterial {
  logKey: string;
  relays: JoinMaterialRelay[];
  caFingerprint: string | null;
}

function readCaFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const fingerprint = value.trim().toLowerCase();
  return CA_FINGERPRINT_HEX.test(fingerprint) ? fingerprint : null;
}

function spkiSha256FromPem(pem: string): string | null {
  const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!match) return null;
  try {
    const cert = new X509Certificate(match[0]);
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    return createHash('sha256').update(spki).digest('hex');
  } catch {
    return null;
  }
}

function fingerprintFromStatus(status: RelayStatusJson | null): string | null {
  const direct = readCaFingerprint(status?.caFingerprint);
  if (direct) return direct;
  const rows = status?.relays ?? [];
  const attached = rows.find((row) => row.attached);
  const ordered = attached ? [attached, ...rows.filter((row) => row !== attached)] : rows;
  for (const row of ordered) {
    const found = readCaFingerprint(row.caFingerprint);
    if (found) return found;
  }
  return null;
}

async function fingerprintFromTlsCaCrt(ctx: CliContext): Promise<string | null> {
  const response = await ctx.http.fetch(SELF_NODE_ID, '/api/tls/ca.crt');
  if (!response.ok) return null;
  return spkiSha256FromPem(await response.text());
}

/** 自签中继的 SPKI sha256：join-material → relay status → GET /api/tls/ca.crt。LE / 无 CA 为 null。 */
export async function resolveRelayJoinCaFingerprint(
  ctx: CliContext,
  material: Pick<JoinMaterial, 'caFingerprint'>
): Promise<string | null> {
  return (
    readCaFingerprint(material.caFingerprint) ??
    fingerprintFromStatus(await fetchRelayStatus(ctx)) ??
    (await fingerprintFromTlsCaCrt(ctx))
  );
}

interface EnrollmentRelayRow {
  url: string;
  tenantId?: string;
  token?: string;
  accepted?: boolean;
  error?: string;
}

async function fetchJoinMaterial(ctx: CliContext): Promise<JoinMaterial> {
  const wire = await ctx.http.json<Partial<JoinMaterial>>(
    SELF_NODE_ID,
    'GET',
    '/api/mesh/relay/join-material'
  );
  const relays = wire.relays ?? [];
  const usable =
    JOIN_KEY_B64URL.test(wire.logKey as string) &&
    relays.length > 0 &&
    relays.every(
      (relay) =>
        Boolean(relay?.url) &&
        JOIN_KEY_B64URL.test(relay?.token) &&
        NODE_ID_PATTERN.test(relay?.tenantId)
    );
  if (!usable) {
    throw new CliError('relay join-material is incomplete; cannot mint an r3. join token');
  }
  return {
    logKey: wire.logKey as string,
    relays,
    caFingerprint: readCaFingerprint(wire.caFingerprint),
  };
}

function tokenOf(material: JoinMaterial, url: string): string {
  return material.relays.find((relay) => relay.url === url)?.token ?? '';
}

function acceptedJoinRelays(
  material: JoinMaterial,
  createdRelays: string[] | EnrollmentRelayRow[] | undefined
): JoinMaterialRelay[] {
  if (!createdRelays || createdRelays.length === 0) return material.relays;
  if (typeof createdRelays[0] === 'string') {
    const urls = createdRelays as string[];
    const targets = urls
      .map((url) => material.relays.find((relay) => relay.url === url))
      .filter((relay): relay is JoinMaterialRelay => relay !== undefined);
    if (targets.length === 0) {
      throw new CliError('no relay from join-material matched the enrollment');
    }
    return targets;
  }
  const rows = (createdRelays as EnrollmentRelayRow[]).filter((row) => row.accepted !== false);
  const usable = rows
    .map((row) => ({
      url: row.url,
      tenantId: row.tenantId ?? '',
      token: row.token ?? tokenOf(material, row.url),
    }))
    .filter((row) => row.token && NODE_ID_PATTERN.test(row.tenantId));
  if (usable.length === 0) {
    throw new CliError('no relay accepted the enrollment');
  }
  return usable;
}

interface RelayEnrollmentCreated {
  id: string;
  expiresAt?: number;
  expires_at?: number;
  relays?: string[] | EnrollmentRelayRow[];
}

export async function createRelayEnrollment(
  ctx: CliContext,
  options: { ttlMs: number; name?: string }
): Promise<CreatedEnrollmentResult> {
  const material = await fetchJoinMaterial(ctx);
  const caFingerprint = await resolveRelayJoinCaFingerprint(ctx, material);
  return withRootKey(ctx, async (root, mode) => {
    const now = Date.now();
    const enrollment = await createEnrollment(root, {
      uid: mode.uid as string,
      rootEpoch: mode.rootEpoch as number,
      now,
      ttlMs: options.ttlMs,
    });
    const logKey = decodeBase64url(material.logKey);
    let tokens: Uint8Array[] = [];
    try {
      const head = await keyLogHead(ctx);
      const created = await ctx.http.json<RelayEnrollmentCreated>(
        SELF_NODE_ID,
        'POST',
        '/api/mesh/relay/enrollments',
        {
          enroll_pk: encodeBase64url(enrollment.enrollPk),
          authorization: encodeBase64url(enrollment.authorizationBytes),
          authorization_sig: encodeBase64url(enrollment.authorizationSig),
          exp: now + options.ttlMs,
        }
      );
      const targets = acceptedJoinRelays(material, created.relays);
      tokens = targets.map((relay) => decodeBase64url(relay.token));
      const joinRelays = targets.map((relay, index) => ({
        url: relay.url,
        tenantId: relay.tenantId,
        token: tokens[index],
      }));
      const rootPk = mode.rootPublicKey ? decodeBase64url(mode.rootPublicKey) : root.publicKey;
      const token = encodeRelayJoinToken({
        enrollSk: enrollment.enrollSk,
        rootPublicKey: rootPk,
        keyLogHeadHash: head.hash,
        logKey,
        relays: joinRelays,
        caFingerprint,
      });
      const publicUrl = joinRelays[0]?.url ?? null;
      return {
        id: created.id,
        expiresAt: created.expiresAt ?? created.expires_at ?? now + options.ttlMs,
        joinToken: token,
        joinCommand:
          publicUrl && isTrustedHubUrl(publicUrl)
            ? joinCommand(publicUrl, token, options.name)
            : null,
        publicUrl,
        caFingerprint,
      };
    } finally {
      enrollment.enrollSk.fill(0);
      logKey.fill(0);
      for (const token of tokens) token.fill(0);
    }
  });
}

export function relayAllowHint(ref: string): string {
  return [
    'relay meshes have no /api/hub/nodes pending list;',
    `if ${ref} is already admitted, run: vibeterm nodes meta-key admit <node-id>`,
  ].join(' ');
}

export async function findRelayAllowTarget(
  ctx: CliContext,
  ref: string,
  relay: boolean
): Promise<AdminNode> {
  try {
    return await findAdminNode(ctx, ref);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    const trimmed = ref.trim();
    if (relay && NODE_ID_PATTERN.test(trimmed)) {
      return { id: trimmed, name: trimmed, mesh: null, hub: null };
    }
    if (relay) throw new NotFoundError(`unknown node: ${ref}`, relayAllowHint(ref));
    throw error;
  }
}
