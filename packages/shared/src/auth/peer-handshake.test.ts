import { describe, expect, it } from 'bun:test';
import { bytesEqual, bytesToHex, encodePeerTranscript } from './encoding';
import {
  buildPeerTranscript,
  derivePeerSessionKeys,
  normalizeFingerprint,
  parseSdpFingerprint,
  signTranscript,
  verifyTranscript,
} from './peer-handshake';
import { generateEd25519KeyPair } from './root-key';

const helloA = {
  node_id: new Uint8Array(16).fill(0x01),
  nonce: new Uint8Array(32).fill(0x0a),
  eph_x25519_pk: new Uint8Array(32).fill(0x21),
  dtls_fingerprint: null,
};

const helloB = {
  node_id: new Uint8Array(16).fill(0x02),
  nonce: new Uint8Array(32).fill(0x0b),
  eph_x25519_pk: new Uint8Array(32).fill(0x22),
  dtls_fingerprint: null,
};

const SESSION_VECTOR_TRANSCRIPT_HEX =
  '0c000000746d65782f706565722f763101010101010101010101010101010101010a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a01212121212121212121212121212121212121212121212121212121212121212100020202020202020202020202020202020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b01222222222222222222222222222222222222222222222222222222222222222200';

const SESSION_VECTOR_SEND = '76b73d813336b4892a442494fbb2dd64c896962f8c4f6c63aa7d671d91d193e2';
const SESSION_VECTOR_RECV = '0096914baa49dc9ac1ced9147ce03b67a0170fb23ae7e213f3bbe4e056a272cf';

describe('peer transcript', () => {
  it('orders hello_lo / hello_hi by node_id independently of call order', () => {
    const ab = buildPeerTranscript('dc', helloA, helloB);
    const ba = buildPeerTranscript('dc', helloB, helloA);
    expect(bytesEqual(ab.hello_lo.node_id, helloA.node_id)).toBe(true);
    expect(bytesEqual(ab.hello_hi.node_id, helloB.node_id)).toBe(true);
    expect(bytesEqual(encodePeerTranscript(ab), encodePeerTranscript(ba))).toBe(true);
  });

  it('signs and verifies the transcript', () => {
    const node = generateEd25519KeyPair();
    const transcript = buildPeerTranscript('dc', helloA, helloB);
    const sig = signTranscript(node.secretKey, transcript);
    expect(verifyTranscript(transcript, sig, node.publicKey)).toBe(true);
    const other = generateEd25519KeyPair();
    expect(verifyTranscript(transcript, sig, other.publicKey)).toBe(false);
  });
});

describe('fingerprint', () => {
  it('normalizes algorithm to lowercase and value to uppercase hex without colons', () => {
    expect(normalizeFingerprint({ algorithm: 'SHA-256', value: 'aa:bb:cc:dd' })).toEqual({
      algorithm: 'sha-256',
      value: 'AABBCCDD',
    });
  });

  it('parses a=fingerprint from SDP', () => {
    const sdp = [
      'v=0',
      'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      'a=setup:actpass',
    ].join('\r\n');
    const fp = parseSdpFingerprint(sdp);
    expect(fp?.algorithm).toBe('sha-256');
    expect(fp?.value.startsWith('AABBCCDD')).toBe(true);
    expect(fp?.value.includes(':')).toBe(false);
    expect(parseSdpFingerprint('v=0\r\n')).toBeNull();
  });
});

describe('derivePeerSessionKeys vector', () => {
  it('locks HKDF-SHA-256(ss, salt=sha256(transcript), info="tmex-sc/v1/" ‖ sender(16B) ‖ "->" ‖ receiver(16B), 32) — shared with link/secure-channel-link', () => {
    const transcript = buildPeerTranscript('relay', helloA, helloB);
    const transcriptBytes = encodePeerTranscript(transcript);
    expect(bytesToHex(transcriptBytes)).toBe(SESSION_VECTOR_TRANSCRIPT_HEX);

    const ss = new Uint8Array(32).fill(0x33);
    const keys = derivePeerSessionKeys(ss, transcriptBytes, helloA.node_id, helloB.node_id);
    expect(bytesToHex(keys.sendKey)).toBe(SESSION_VECTOR_SEND);
    expect(bytesToHex(keys.recvKey)).toBe(SESSION_VECTOR_RECV);

    const peer = derivePeerSessionKeys(ss, transcriptBytes, helloB.node_id, helloA.node_id);
    expect(bytesEqual(peer.sendKey, keys.recvKey)).toBe(true);
    expect(bytesEqual(peer.recvKey, keys.sendKey)).toBe(true);
  });
});
