import type { AdmitNodePayload, EnrollmentSigner } from '@tmex/shared/auth';
import {
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeBase64url,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  hexToBytes,
  nodeIdToHex,
  randomBytes,
  rootKeyFromSeed,
} from '@tmex/shared/auth';
import type { NodeIdentityRecord, NodeIdentityStore } from './node-identity-store';

export type NodeIdentityKeys = {
  nodeId: Uint8Array;
  nodeIdHex: string;
  hubUrl: string | null;
  edPrivateKey: Uint8Array;
  edPublicKey: Uint8Array;
  x25519PrivateKey: Uint8Array;
  x25519PublicKey: Uint8Array;
};

export async function ensureNodeIdentity(
  store: NodeIdentityStore,
  opts?: { hubUrl?: string }
): Promise<NodeIdentityKeys> {
  const loaded = await store.load();
  if (loaded) {
    return identityFromRecord(loaded);
  }
  const nodeId = randomBytes(16);
  const ed = generateEd25519KeyPair();
  const x = generateX25519KeyPair();
  const hubUrl = opts?.hubUrl ?? null;
  await store.save({
    nodeId: nodeIdToHex(nodeId),
    hubUrl,
    edPrivateKey: ed.secretKey,
    x25519PrivateKey: x.secretKey,
    certificateJson: JSON.stringify({ x25519PublicKey: encodeBase64url(x.publicKey) }),
    certSig: new Uint8Array(0),
  });
  return {
    nodeId,
    nodeIdHex: nodeIdToHex(nodeId),
    hubUrl,
    edPrivateKey: ed.secretKey,
    edPublicKey: ed.publicKey,
    x25519PrivateKey: x.secretKey,
    x25519PublicKey: x.publicKey,
  };
}

export async function selfSignedNodeCertificate(
  identity: NodeIdentityKeys,
  signer: EnrollmentSigner,
  opts: { uid: string; rootEpoch: number; now: number | bigint }
): Promise<AdmitNodePayload> {
  const enrollment = await createEnrollment(signer, {
    uid: opts.uid,
    rootEpoch: opts.rootEpoch,
    now: opts.now,
  });
  const cert = createNodeCertificate(enrollment.enrollSk, {
    uid: opts.uid,
    edPk: identity.edPublicKey,
    x25519Pk: identity.x25519PublicKey,
    enrollPk: enrollment.enrollPk,
    now: opts.now,
    nodeId: identity.nodeId,
  });
  return {
    authorization_bytes: enrollment.authorizationBytes,
    authorization_sig: enrollment.authorizationSig,
    certificate_bytes: cert.certificateBytes,
    cert_sig: cert.certSig,
  };
}

function identityFromRecord(record: NodeIdentityRecord): NodeIdentityKeys {
  const edPublicKey = rootKeyFromSeed(record.edPrivateKey).publicKey;
  let x25519PublicKey: Uint8Array = new Uint8Array(32);
  try {
    const meta = JSON.parse(record.certificateJson) as { x25519PublicKey?: string };
    if (typeof meta.x25519PublicKey === 'string') {
      x25519PublicKey = decodeBase64url(meta.x25519PublicKey);
    }
  } catch {
    // identity row may later hold a real certificate JSON
  }
  return {
    nodeId: hexToBytes(record.nodeId),
    nodeIdHex: record.nodeId,
    hubUrl: record.hubUrl,
    edPrivateKey: record.edPrivateKey,
    edPublicKey,
    x25519PrivateKey: record.x25519PrivateKey,
    x25519PublicKey,
  };
}
