import {
  type RootKey,
  createNodeCertificate,
  encodeBase64url,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  nodeIdToHex,
  randomBytes,
  rootKeyFromSeed,
  sha256,
  signEd25519,
} from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import type { HubKeyLogSource } from './types';
import { type UplinkCtlMessage, decodeUplinkCtl, encodeUplinkCtl } from './uplink-protocol';

export class MemoryHubKeyLog implements HubKeyLogSource {
  private readonly logs = new Map<
    string,
    { seq: bigint; bytes: Uint8Array; sig: Uint8Array; hash: Uint8Array }[]
  >();

  seed(userId: string, records: { bytes: Uint8Array; sig: Uint8Array }[]): void {
    const stored: { seq: bigint; bytes: Uint8Array; sig: Uint8Array; hash: Uint8Array }[] = [];
    for (const record of records) {
      const seq = BigInt(stored.length + 1);
      stored.push({
        seq,
        bytes: record.bytes,
        sig: record.sig,
        hash: sha256(concat(record.bytes, record.sig)),
      });
    }
    this.logs.set(userId, stored);
  }

  async head(userId: string): Promise<{ seq: bigint; hash: Uint8Array }> {
    const recs = this.logs.get(userId) ?? [];
    const last = recs.at(-1);
    if (!last) return { seq: 0n, hash: new Uint8Array(32) };
    return { seq: last.seq, hash: last.hash };
  }

  async list(
    userId: string,
    fromSeq?: bigint
  ): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]> {
    const recs = this.logs.get(userId) ?? [];
    return recs
      .filter((r) => fromSeq === undefined || r.seq >= fromSeq)
      .map((r) => ({ seq: r.seq, bytes: r.bytes, sig: r.sig }));
  }

  async append(
    userId: string,
    record: { bytes: Uint8Array; sig: Uint8Array }
  ): Promise<{ ok: true; seq: bigint; hash: Uint8Array } | { ok: false; error: string }> {
    const recs = this.logs.get(userId) ?? [];
    const seq = (recs.at(-1)?.seq ?? 0n) + 1n;
    const hash = sha256(concat(record.bytes, record.sig));
    recs.push({ seq, bytes: record.bytes, sig: record.sig, hash });
    this.logs.set(userId, recs);
    return { ok: true, seq, hash };
  }
}

export type SeededUser = {
  id: string;
  root: RootKey;
};

export function seedUser(
  store: UserStore,
  opts?: { id?: string; username?: string; now?: number }
): SeededUser {
  const id = opts?.id ?? 'user-1';
  const root = rootKeyFromSeed(randomBytes(32));
  store.create({
    id,
    username: opts?.username ?? 'alice',
    rootPublicKey: root.publicKey,
    rootEpoch: 0,
    kdfParamsJson: JSON.stringify({ kdf: 'argon2id' }),
    keyLogHeadSeq: 0,
    keyLogHeadHash: new Uint8Array(32),
    now: opts?.now ?? 1_000,
  });
  return { id, root };
}

export type SeededNode = {
  nodeId: string;
  ed: { secretKey: Uint8Array; publicKey: Uint8Array };
  enroll: { secretKey: Uint8Array; publicKey: Uint8Array };
  certBytes: Uint8Array;
  certSig: Uint8Array;
};

export function seedAdmittedNode(
  store: UserStore,
  userId: string,
  opts?: { name?: string; now?: number; revoked?: boolean }
): SeededNode {
  const now = opts?.now ?? Date.now();
  const ed = generateEd25519KeyPair();
  const x = generateX25519KeyPair();
  const enroll = generateEd25519KeyPair();
  const cert = createNodeCertificate(enroll.secretKey, {
    uid: userId,
    edPk: ed.publicKey,
    x25519Pk: x.publicKey,
    enrollPk: enroll.publicKey,
    now,
  });
  const nodeId = nodeIdToHex(cert.nodeId);
  store.upsertCert({
    nodeId,
    userId,
    admitRecordSeq: 1,
    certificateBytes: cert.certificateBytes,
    certSig: cert.certSig,
    authorizationBytes: enroll.publicKey,
    authorizationSig: new Uint8Array(64),
    revokedLogSeq: opts?.revoked ? 9 : null,
  });
  store.createNode({
    id: nodeId,
    userId,
    name: opts?.name ?? nodeId.slice(0, 8),
    status: opts?.revoked ? 'revoked' : 'enrolled',
    now,
  });
  return {
    nodeId,
    ed,
    enroll,
    certBytes: cert.certificateBytes,
    certSig: cert.certSig,
  };
}

export function signAuth(secretKey: Uint8Array, nonce: Uint8Array): string {
  return encodeBase64url(signEd25519(secretKey, nonce));
}

export type CtlInbox = {
  take(timeoutMs?: number): Promise<UplinkCtlMessage>;
  drain(): UplinkCtlMessage[];
};

export function ctlInbox(link: LinkSession): CtlInbox {
  const queue: UplinkCtlMessage[] = [];
  const waiters: Array<(msg: UplinkCtlMessage) => void> = [];
  link.ctl.onMessage((bytes) => {
    const msg = decodeUplinkCtl(bytes);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return {
    take(timeoutMs = 1_000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<UplinkCtlMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ctl timeout')), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    drain() {
      const out = queue.slice();
      queue.length = 0;
      return out;
    },
  };
}

export function sendCtl(link: LinkSession, msg: UplinkCtlMessage): void {
  link.ctl.send(encodeUplinkCtl(msg));
}

export function autoPong(link: LinkSession): void {
  link.ctl.onMessage((bytes) => {
    try {
      const msg = decodeUplinkCtl(bytes);
      if (msg.t === 'ping') sendCtl(link, { t: 'pong' });
    } catch {
      // ignore malformed
    }
  });
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
