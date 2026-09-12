import { describe, expect, test } from 'bun:test';
import {
  ATTR,
  CLASS,
  METHOD,
  addressAttribute,
  decodeAddress,
  decodeChannelData,
  decodeErrorCode,
  decodeMessage,
  encodeChannelData,
  encodeMessage,
  errorAttribute,
  getAttribute,
  isChannelData,
  longTermKey,
  textAttribute,
  verifyFingerprint,
  verifyIntegrity,
} from './stun-message';

const hex = (value: string) => Buffer.from(value.replace(/\s+/g, ''), 'hex');

describe('STUN codec RFC5769 vectors', () => {
  test('binding request fingerprint and integrity', () => {
    const raw = hex(`000100582112a442b7e7a701bc34d686fa87dfae
      802200105354554e207465737420636c69656e74002400046e0001ff
      80290008932ff9b151263b36000600096576746a3a68367659202020
      000800149aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a280280004e57a3bcf`);
    const message = decodeMessage(raw)!;
    expect(verifyFingerprint(message)).toBe(true);
    expect(verifyIntegrity(message, Buffer.from('VOkJxbRl1RmTxUk/WvJxBt'))).toBe(true);
  });

  test('IPv4 response fingerprint and IPv6 address decode', () => {
    const raw = hex(`0101003c2112a442b7e7a701bc34d686fa87dfae
      8022000b7465737420766563746f72200020 00080001a147e112a643
      000800142b91f599fd9e90c38c7489f92af9ba53f06be7d780280004c07d4c96`);
    const message = decodeMessage(raw)!;
    expect(verifyFingerprint(message)).toBe(true);
    expect(getAttribute(message, ATTR.XOR_MAPPED_ADDRESS)).toBeDefined();
    const tx = message.transactionId;
    const attr = getAttribute(message, ATTR.XOR_MAPPED_ADDRESS)!;
    expect(decodeAddress(attr, tx)).toEqual({ address: '192.0.2.1', port: 32853 });
  });
});

test('RFC 5769 §2.4 long-term credential Binding request', () => {
  const raw = hex(`
    00010060 2112a442 78ad3433 c6ad72c0 29da412e
    00060012 e3839ee3 8388e383 aae38383 e382afe3 82b90000
    0015001c 662f2f34 39396b39 35346436 4f4c3334 6f4c3946
               53547679 36347341
    0014000b 6578616d 706c652e 6f726700
    00080014 f6702465 6dd64a3e 02b8e071 2e85c9a2 8ca89666
  `);
  const message = decodeMessage(raw)!;
  expect(message.method).toBe(METHOD.BINDING);
  expect(message.class).toBe(CLASS.REQUEST);
  expect(getAttribute(message, ATTR.USERNAME)?.toString('utf8')).toBe('マトリックス');
  expect(getAttribute(message, ATTR.REALM)?.toString('utf8')).toBe('example.org');
  expect(getAttribute(message, ATTR.NONCE)?.toString('utf8')).toBe('f//499k954d6OL34oL9FSTvy64sA');
  const key = longTermKey('マトリックス', 'example.org', 'TheMatrIX');
  expect(verifyIntegrity(message, key)).toBe(true);
});

test('encode/decode authenticated address', () => {
  const tx = Buffer.alloc(12, 7);
  const key = longTermKey('u', 'r', 'p');
  const message = encodeMessage({
    method: METHOD.BINDING,
    class: CLASS.REQUEST,
    transactionId: tx,
    attributes: [
      textAttribute(ATTR.USERNAME, 'u'),
      addressAttribute(ATTR.XOR_MAPPED_ADDRESS, { address: '2001:db8::1', port: 1234 }, tx),
    ],
    integrityKey: key,
  });
  const decoded = decodeMessage(message)!;
  expect(verifyIntegrity(decoded, key)).toBe(true);
  expect(verifyFingerprint(decoded)).toBe(true);
  expect(decodeAddress(getAttribute(decoded, ATTR.XOR_MAPPED_ADDRESS)!, tx)?.port).toBe(1234);
});

test('ChannelData round-trip and error-code encode', () => {
  const packed = encodeChannelData(0x4001, Buffer.from('hi'));
  expect(isChannelData(packed)).toBe(true);
  expect(decodeChannelData(packed)).toEqual({ channel: 0x4001, data: Buffer.from('hi') });
  const err = errorAttribute(438, 'Stale Nonce');
  expect(decodeErrorCode(err.value)).toEqual({ code: 438, reason: 'Stale Nonce' });
});
