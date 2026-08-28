import { describe, expect, test } from 'bun:test';
import { collectTmexHeaders, sha256Hex } from './hash.ts';

describe('sha256Hex', () => {
  test('hashes empty and known vectors', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('collectTmexHeaders', () => {
  test('keeps x-tmex-* plus length/type', () => {
    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Content-Length': '8',
      'X-Tmex-Via': 'relay',
      Date: 'Wed, 01 Jan 2020 00:00:00 GMT',
    });
    expect(collectTmexHeaders(headers)).toEqual({
      'content-type': 'application/octet-stream',
      'content-length': '8',
      'x-tmex-via': 'relay',
    });
  });
});
