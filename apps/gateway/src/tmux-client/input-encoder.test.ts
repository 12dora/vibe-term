import { describe, expect, test } from 'bun:test';

import {
  SEND_KEYS_HEX_CHUNK_BYTES,
  encodeBytesToHexChunks,
  encodeInputToHexChunks,
} from './input-encoder';

describe('input encoder', () => {
  test('encodes utf-8 input into tmux send-keys hex chunks', () => {
    expect(encodeInputToHexChunks('A中')).toEqual([['41', 'e4', 'b8', 'ad']]);
  });

  test('splits long payloads at 256 bytes to match tmux send-keys -H behavior', () => {
    const chunks = encodeInputToHexChunks('a'.repeat(SEND_KEYS_HEX_CHUNK_BYTES + 1));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(SEND_KEYS_HEX_CHUNK_BYTES);
    expect(chunks[1]).toEqual(['61']);
  });

  test('preserves arbitrary canonical input bytes without a text round trip', () => {
    expect(encodeBytesToHexChunks(new Uint8Array([0x00, 0x80, 0xff]))).toEqual([
      ['00', '80', 'ff'],
    ]);
  });
});
