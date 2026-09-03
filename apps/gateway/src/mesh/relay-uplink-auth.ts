import {
  decodeBase64url,
  encodeBase64url,
  signEd25519,
  uplinkAuthMessage,
} from '@tmex/shared/auth';
import {
  RELAY_PROTO_VERSION,
  type RelayCtlMessage,
  type RelayMemberProof,
} from '@tmex/shared/relay';
import type { UserStore } from '../auth/user-store';
import type { RelaySecrets } from './relay-secrets';
import type { KeyLogApplier, MeshIdentity } from './types';

export type RelayAuthContext = {
  identity: MeshIdentity;
  relayUrl: string;
  relayHost: string;
  clientVersion: string;
  secrets: RelaySecrets;
  userStore: UserStore;
  applier: KeyLogApplier;
  userId: string;
};

export type RelayAuthResult =
  | { ok: true; msg: Extract<RelayCtlMessage, { t: 'relay.auth' }> }
  | { ok: false; error: string };

/**
 * 自己的 admit-node 记录：中继据此把本节点从 pending 提到 admitted。
 * 拿不到（未被承认 / 记录缺失）就不带，由中继按已有注册表判断。
 */
export async function relayMemberProof(
  ctx: RelayAuthContext
): Promise<RelayMemberProof | undefined> {
  const cert = ctx.userStore.getCert(ctx.identity.nodeId);
  if (!ctx.userId || !cert || cert.userId !== ctx.userId || cert.revokedLogSeq != null) {
    return undefined;
  }
  try {
    const seq = BigInt(cert.admitRecordSeq);
    const rows = (await ctx.applier.list?.(ctx.userId, seq, undefined, 1)) ?? [];
    const row = rows.find((entry) => entry.seq === seq);
    if (!row) return undefined;
    return { bytes: encodeBase64url(row.bytes), sig: encodeBase64url(row.sig) };
  } catch {
    return undefined;
  }
}

/** challenge → `relay.auth`：租户令牌 + Ed25519(nonce ‖ relay host) + 成员证明。 */
export async function buildRelayAuth(
  ctx: RelayAuthContext,
  nonceB64: string
): Promise<RelayAuthResult> {
  let nonce: Uint8Array;
  try {
    nonce = decodeBase64url(nonceB64);
  } catch {
    return { ok: false, error: 'bad-nonce' };
  }
  if (nonce.byteLength !== 32) return { ok: false, error: 'bad-nonce' };
  const relay = await ctx.secrets.store.getRelay(ctx.relayUrl).catch(() => null);
  if (!relay) return { ok: false, error: 'relay-not-configured' };
  const sig = signEd25519(ctx.identity.edSecretKey, uplinkAuthMessage(nonce, ctx.relayHost));
  const member = await relayMemberProof(ctx);
  return {
    ok: true,
    msg: {
      t: 'relay.auth',
      tenant_id: relay.tenantId,
      token: encodeBase64url(relay.token),
      node_id: ctx.identity.nodeId,
      sig: encodeBase64url(sig),
      proto: RELAY_PROTO_VERSION,
      client_version: ctx.clientVersion,
      ...(member ? { member } : {}),
    },
  };
}

export type RelayEnrollCreateInput = {
  id: string;
  enrollPk: Uint8Array;
  authorization: Uint8Array;
  authorizationSig: Uint8Array;
  exp: number;
};

export type RelayEnrollAck = { ok: boolean; error?: string };

/** `relay.enroll.create` 的等待表：建/落 ack/断链清空三件事凑一起，省得散在 uplink 客户端里。 */
export class RelayEnrollChannel {
  private readonly waiters = new Map<string, (ack: RelayEnrollAck) => void>();

  constructor(private readonly send: (msg: RelayCtlMessage) => void) {}

  create(input: RelayEnrollCreateInput, timeoutMs: number): Promise<RelayEnrollAck> {
    return sendRelayEnrollCreate(input, { send: this.send, waiters: this.waiters, timeoutMs });
  }

  settle(msg: Extract<RelayCtlMessage, { t: 'relay.enroll.ack' }>): void {
    const waiter = this.waiters.get(msg.id);
    this.waiters.delete(msg.id);
    waiter?.({ ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) });
  }

  reset(error: string): void {
    for (const waiter of this.waiters.values()) waiter({ ok: false, error });
    this.waiters.clear();
  }
}

/** `relay.enroll.create` + 等 ack；离线或超时都返回失败而不抛。 */
export function sendRelayEnrollCreate(
  input: RelayEnrollCreateInput,
  deps: {
    send: (msg: RelayCtlMessage) => void;
    waiters: Map<string, (ack: RelayEnrollAck) => void>;
    timeoutMs: number;
  }
): Promise<RelayEnrollAck> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      deps.waiters.delete(input.id);
      resolve({ ok: false, error: 'RELAY_TIMEOUT' });
    }, deps.timeoutMs);
    deps.waiters.set(input.id, (ack) => {
      clearTimeout(timer);
      resolve(ack.ok ? { ok: true } : { ok: false, error: ack.error ?? 'RELAY_REJECTED' });
    });
    try {
      deps.send({
        t: 'relay.enroll.create',
        id: input.id,
        enroll_pk: encodeBase64url(input.enrollPk),
        authorization: encodeBase64url(input.authorization),
        authorization_sig: encodeBase64url(input.authorizationSig),
        exp: input.exp,
      });
    } catch {
      deps.waiters.delete(input.id);
      clearTimeout(timer);
      resolve({ ok: false, error: 'RELAY_OFFLINE' });
    }
  });
}
