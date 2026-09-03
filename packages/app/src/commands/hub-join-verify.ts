import {
  bytesEqual,
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeBase64url,
  decodeCertificate,
  decodeKeyLogRecord,
} from '../../../shared/src/auth';
import type { RedeemResponse } from '../lib/hub-client';

export type ProjectedNodeCerts = Map<
  string,
  {
    certificateBytes: Uint8Array;
    certSig: Uint8Array;
    authorizationBytes: Uint8Array;
    authorizationSig: Uint8Array;
    revoked: boolean;
  }
>;

export function assertChainUids(records: Array<{ bytes: Uint8Array }>, genesisUid: string): void {
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

export function assertResponseCertsMatchProjections(
  redeemed: RedeemResponse,
  state: { nodeCerts: ProjectedNodeCerts },
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
