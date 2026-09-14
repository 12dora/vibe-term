import {
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeCertificate,
  decodeKeyLogRecord,
} from '../../../shared/src/auth';

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
