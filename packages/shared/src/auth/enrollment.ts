import type { Authorization, Certificate } from './encoding';
import {
  DOMAIN_AUTHORIZATION,
  DOMAIN_CERTIFICATE,
  decodeBase64url,
  encodeAuthorization,
  encodeBase64url,
  encodeCertificate,
  randomBytes,
} from './encoding';
import type { RootKey } from './root-key';
import { generateEd25519KeyPair, signEd25519, verifyEd25519 } from './root-key';

export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
export const JOIN_TOKEN_BYTES = 96;
export const JOIN_TOKEN_CHARS = 128;

export type PasskeySigner = {
  credentialId: string;
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
};

export type EnrollmentSigner = RootKey | PasskeySigner;

export type Enrollment = {
  enrollSk: Uint8Array;
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
};

export type JoinToken = {
  enrollSk: Uint8Array;
  rootPublicKey: Uint8Array;
  keyLogHeadHash: Uint8Array;
};

export type NodeCertificate = {
  nodeId: Uint8Array;
  certificate: Certificate;
  certificateBytes: Uint8Array;
  certSig: Uint8Array;
};

function toMs(now: number | bigint): bigint {
  return typeof now === 'bigint' ? now : BigInt(now);
}

function isPasskeySigner(signer: EnrollmentSigner): signer is PasskeySigner {
  return typeof (signer as PasskeySigner).credentialId === 'string';
}

export async function createEnrollment(
  signer: EnrollmentSigner,
  opts: { uid: string; rootEpoch: number; now: number | bigint; ttlMs?: number }
): Promise<Enrollment> {
  const enroll = generateEd25519KeyPair();
  const issued = toMs(opts.now);
  const ttl = opts.ttlMs ?? ENROLLMENT_TTL_MS;
  const passkey = isPasskeySigner(signer);
  const authorization: Authorization = {
    domain: DOMAIN_AUTHORIZATION,
    uid: opts.uid,
    enroll_pk: enroll.publicKey,
    exp: issued + BigInt(ttl),
    root_epoch: opts.rootEpoch,
    signer: passkey ? 'passkey' : 'root',
    credential_id: passkey ? signer.credentialId : null,
  };
  const authorizationBytes = encodeAuthorization(authorization);
  const authorizationSig = await Promise.resolve(signer.sign(authorizationBytes));
  return {
    enrollSk: enroll.secretKey,
    enrollPk: enroll.publicKey,
    authorizationBytes,
    authorizationSig,
  };
}

export function encodeJoinToken(
  enrollSk: Uint8Array,
  rootPublicKey: Uint8Array,
  keyLogHeadHash: Uint8Array
): string {
  if (enrollSk.length !== 32 || rootPublicKey.length !== 32 || keyLogHeadHash.length !== 32) {
    throw new Error('join token fields must each be 32 bytes');
  }
  const raw = new Uint8Array(JOIN_TOKEN_BYTES);
  raw.set(enrollSk, 0);
  raw.set(rootPublicKey, 32);
  raw.set(keyLogHeadHash, 64);
  const token = encodeBase64url(raw);
  raw.fill(0);
  if (token.length !== JOIN_TOKEN_CHARS) {
    throw new Error(`join token must be ${JOIN_TOKEN_CHARS} chars`);
  }
  return token;
}

export function decodeJoinToken(token: string): JoinToken {
  const raw = decodeBase64url(token);
  if (raw.length !== JOIN_TOKEN_BYTES) {
    throw new Error(`join token must decode to ${JOIN_TOKEN_BYTES} bytes`);
  }
  return {
    enrollSk: raw.slice(0, 32),
    rootPublicKey: raw.slice(32, 64),
    keyLogHeadHash: raw.slice(64, 96),
  };
}

export function createNodeCertificate(
  enrollSk: Uint8Array,
  opts: {
    uid: string;
    edPk: Uint8Array;
    x25519Pk: Uint8Array;
    enrollPk: Uint8Array;
    now: number | bigint;
    nodeId?: Uint8Array;
  }
): NodeCertificate {
  const nodeId = opts.nodeId ? new Uint8Array(opts.nodeId) : randomBytes(16);
  if (nodeId.length !== 16) {
    throw new Error('nodeId must be 16 bytes');
  }
  const certificate: Certificate = {
    domain: DOMAIN_CERTIFICATE,
    uid: opts.uid,
    node_id: nodeId,
    ed_pk: new Uint8Array(opts.edPk),
    x25519_pk: new Uint8Array(opts.x25519Pk),
    enroll_pk: new Uint8Array(opts.enrollPk),
    issued_at: toMs(opts.now),
  };
  const certificateBytes = encodeCertificate(certificate);
  const certSig = signEd25519(enrollSk, certificateBytes);
  return { nodeId, certificate, certificateBytes, certSig };
}

export function verifyNodeCertificate(
  certBytes: Uint8Array,
  certSig: Uint8Array,
  enrollPk: Uint8Array
): boolean {
  return verifyEd25519(certSig, certBytes, enrollPk);
}
