import {
  type PeerHello,
  decodeBase64url,
  decodeCertificate,
  encodeBase64url,
  generateX25519KeyPair,
  hexToBytes,
  nodeIdToHex,
} from '@vibeterm/shared/auth';
import type { UserStore } from '../auth/user-store';
import { isRecord, requireString } from './ctl';
import type { PeerHelloWire } from './peer-protocol';
import { type MeshIdentity, PeerHandshakeError } from './types';

/** 本机 hello：新生成一次性 X25519 密钥对，`ephSk` 只留给本次握手派生会话密钥。 */
export function createSelfHello(identity: MeshIdentity): {
  selfHello: PeerHello;
  ephSk: Uint8Array;
} {
  const selfId = hexToBytes(identity.nodeId);
  if (selfId.byteLength !== 16) {
    throw new PeerHandshakeError('protocol', 'identity.nodeId must be 16 bytes hex');
  }
  const eph = generateX25519KeyPair();
  const selfHello: PeerHello = {
    node_id: selfId,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    eph_x25519_pk: eph.publicKey,
    dtls_fingerprint: null,
  };
  return { selfHello, ephSk: eph.secretKey };
}

export function selfHelloWire(selfHello: PeerHello): PeerHelloWire {
  return {
    t: 'hello',
    node_id: nodeIdToHex(selfHello.node_id),
    nonce: encodeBase64url(selfHello.nonce),
    eph_x25519_pk: encodeBase64url(selfHello.eph_x25519_pk as Uint8Array),
    dtls_fingerprint: null,
  };
}

export function parseHello(msg: Record<string, unknown>): { hello: PeerHello; nodeIdHex: string } {
  if (msg.t !== 'hello') {
    throw new PeerHandshakeError('protocol', `expected hello, got ${String(msg.t)}`);
  }
  const nodeIdHex = requireString(msg.node_id, 'node_id').toLowerCase();
  const nonce = decodeBase64url(requireString(msg.nonce, 'nonce'));
  const eph = decodeBase64url(requireString(msg.eph_x25519_pk, 'eph_x25519_pk'));
  if (nonce.byteLength !== 32) {
    throw new PeerHandshakeError('protocol', 'hello nonce must be 32 bytes');
  }
  if (eph.byteLength !== 32) {
    throw new PeerHandshakeError('protocol', 'hello eph_x25519_pk must be 32 bytes');
  }
  const nodeId = hexToBytes(nodeIdHex);
  if (nodeId.byteLength !== 16) {
    throw new PeerHandshakeError('protocol', 'hello node_id must be 16 bytes');
  }
  let dtls: PeerHello['dtls_fingerprint'] = null;
  if (msg.dtls_fingerprint && isRecord(msg.dtls_fingerprint)) {
    dtls = {
      algorithm: requireString(msg.dtls_fingerprint.algorithm, 'dtls_fingerprint.algorithm'),
      value: requireString(msg.dtls_fingerprint.value, 'dtls_fingerprint.value'),
    };
  }
  return {
    nodeIdHex,
    hello: {
      node_id: nodeId,
      nonce,
      eph_x25519_pk: eph,
      dtls_fingerprint: dtls,
    },
  };
}

export function lookupPeerEdPk(userStore: UserStore, nodeIdHex: string): Uint8Array {
  const cert = userStore.getCert(nodeIdHex);
  if (!cert) {
    throw new PeerHandshakeError('unknown', `no node_certs for ${nodeIdHex}`);
  }
  if (cert.revokedLogSeq != null) {
    throw new PeerHandshakeError('revoked', `node ${nodeIdHex} is revoked`);
  }
  const decoded = decodeCertificate(cert.certificateBytes);
  if (nodeIdToHex(decoded.node_id) !== nodeIdHex) {
    throw new PeerHandshakeError('protocol', 'certificate node_id mismatch');
  }
  return decoded.ed_pk;
}

export function assertAcceptableHandshakePeer(
  peerNodeId: string,
  identity: MeshIdentity,
  expectedPeerId?: string
): void {
  const selfId = identity.nodeId.toLowerCase();
  const peerId = peerNodeId.toLowerCase();
  if (peerId === selfId) {
    throw new PeerHandshakeError('protocol', 'peer node_id must not be self');
  }
  if (expectedPeerId && peerId !== expectedPeerId.toLowerCase()) {
    throw new PeerHandshakeError('protocol', 'peer node_id mismatch');
  }
}
