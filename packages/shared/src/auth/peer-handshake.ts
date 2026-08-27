import { sha256 } from '@noble/hashes/sha2.js';
import { deriveSecureChannelKeys } from '../link/secure-channel-link';
import type { DtlsFingerprint, PeerHello, PeerPath, PeerTranscript } from './encoding';
import { DOMAIN_PEER, compareBytes, encodePeerTranscript } from './encoding';
import { signEd25519, verifyEd25519 } from './root-key';

export const PEER_SESSION_INFO_PREFIX = 'tmex-sc/v1/';

export type PeerSessionKeys = {
  sendKey: Uint8Array;
  recvKey: Uint8Array;
};

export function buildPeerTranscript(
  path: PeerPath,
  helloA: PeerHello,
  helloB: PeerHello
): PeerTranscript {
  const ordered = compareBytes(helloA.node_id, helloB.node_id) <= 0;
  return {
    domain: DOMAIN_PEER,
    path,
    hello_lo: ordered ? helloA : helloB,
    hello_hi: ordered ? helloB : helloA,
  };
}

export function signTranscript(
  nodeEdSk: Uint8Array,
  transcript: PeerTranscript | Uint8Array
): Uint8Array {
  const bytes = transcript instanceof Uint8Array ? transcript : encodePeerTranscript(transcript);
  return signEd25519(nodeEdSk, bytes);
}

export function verifyTranscript(
  transcript: PeerTranscript | Uint8Array,
  sig: Uint8Array,
  nodeEdPk: Uint8Array
): boolean {
  const bytes = transcript instanceof Uint8Array ? transcript : encodePeerTranscript(transcript);
  return verifyEd25519(sig, bytes, nodeEdPk);
}

export function normalizeFingerprint(fp: { algorithm: string; value: string }): DtlsFingerprint {
  return {
    algorithm: fp.algorithm.trim().toLowerCase(),
    value: fp.value.replace(/[:\s]/g, '').toUpperCase(),
  };
}

export function parseSdpFingerprint(sdp: string): DtlsFingerprint | null {
  const match = sdp.match(/(?:^|\r?\n)a=fingerprint:([^\s]+)\s+([0-9A-Fa-f:]+)\s*$/im);
  if (!match) {
    return null;
  }
  return normalizeFingerprint({ algorithm: match[1], value: match[2] });
}

export function derivePeerSessionKeys(
  sharedSecret: Uint8Array,
  transcriptBytes: Uint8Array,
  selfNodeId: Uint8Array,
  peerNodeId: Uint8Array
): PeerSessionKeys {
  return deriveSecureChannelKeys(sharedSecret, sha256(transcriptBytes), selfNodeId, peerNodeId);
}
