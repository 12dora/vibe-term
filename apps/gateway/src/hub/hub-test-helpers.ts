import {
  type KeyLogType,
  type RootKey,
  buildKeyLogRecord,
  createNodeCertificate,
  encodeBase64url,
  encodeKeyLogRecord,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  nodeIdToHex,
  randomBytes,
  rootKeyFromSeed,
  signEd25519,
  signKeyLogRecordWithRoot,
  uplinkAuthMessage,
} from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import { KeyLogStore } from '../auth/key-log-store';
import { NodeSessionStore } from '../auth/node-session-store';
import type { AuthDb } from '../auth/types';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { createHubKeyLogSource } from './hub-key-log-source';
import type { HubKeyLogSource } from './types';
import { type UplinkCtlMessage, decodeUplinkCtl, encodeUplinkCtl } from './uplink-protocol';

export type HubTestStack = {
  userStore: UserStore;
  keyLogStore: KeyLogStore;
  nodeSessionStore: NodeSessionStore;
  service: UserKeyService;
  keyLogSource: HubKeyLogSource;
};

export function createHubTestStack(db: AuthDb): HubTestStack {
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const service = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
  const keyLogSource = createHubKeyLogSource(service, keyLogStore);
  return { userStore, keyLogStore, nodeSessionStore, service, keyLogSource };
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
  nodeIdBytes: Uint8Array;
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
    nodeIdBytes: cert.nodeId,
    ed,
    enroll,
    certBytes: cert.certificateBytes,
    certSig: cert.certSig,
  };
}

export function signUserRecord(
  service: UserKeyService,
  userId: string,
  root: RootKey,
  type: KeyLogType,
  payload: Uint8Array,
  opts?: { epoch?: number; headSeqOffset?: bigint; signerKey?: RootKey }
): { bytes: Uint8Array; sig: Uint8Array } {
  const state = service.currentState(userId);
  const head = opts?.headSeqOffset
    ? { seq: state.head.seq + opts.headSeqOffset, hash: state.head.hash }
    : state.head;
  const record = buildKeyLogRecord(head, opts?.epoch ?? state.rootEpoch, {
    uid: userId,
    type,
    payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(opts?.signerKey ?? root, bytes);
  return { bytes, sig };
}

export const TEST_HUB_HOST = 'hub.example';

export function signAuth(
  secretKey: Uint8Array,
  nonce: Uint8Array,
  hubHost = TEST_HUB_HOST
): string {
  return encodeBase64url(signEd25519(secretKey, uplinkAuthMessage(nonce, hubHost)));
}

export type CtlInbox = {
  take(timeoutMs?: number): Promise<UplinkCtlMessage>;
  drain(): UplinkCtlMessage[];
};

export function ctlInbox(link: LinkSession): CtlInbox {
  const queue: UplinkCtlMessage[] = [];
  const waiters: Array<(msg: UplinkCtlMessage) => void> = [];
  link.ctl.onMessage((bytes) => {
    const msg = decodeUplinkCtl(bytes, { allowKeyLogRes: true });
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

export function sendRawCtl(link: LinkSession, jsonText: string): void {
  link.ctl.send(new TextEncoder().encode(jsonText));
}

export function paddedCtlJson(fields: Record<string, unknown>, size: number): string {
  const empty = JSON.stringify({ ...fields, pad: '' });
  const prefix = empty.slice(0, -2);
  const suffix = '"}';
  const padLen = size - prefix.length - suffix.length;
  if (padLen < 0) {
    throw new Error(`paddedCtlJson target ${size} is smaller than ${empty.length}`);
  }
  return `${prefix}${'x'.repeat(padLen)}${suffix}`;
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
