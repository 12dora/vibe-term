import { describe, expect, test } from 'bun:test';
import { generateTenantKey, sealEnvelope } from '../../../shared/src/relay';
import {
  decodeRelayKeyLogPlaintext,
  encodeRelayKeyLogPlaintext,
  openRelayKeyLogPage,
  parseRelayKeyLogPage,
} from './relay-keylog';

const KEY = generateTenantKey();

function entry(seed: number, sigLength = 64) {
  return {
    bytes: new Uint8Array([seed, seed + 1, seed + 2]),
    sig: new Uint8Array(sigLength).fill(seed),
  };
}

async function sealEntry(seq: number, seed: number) {
  return {
    seq,
    blob: await sealEnvelope(KEY, 'keylog', encodeRelayKeyLogPlaintext(entry(seed))),
  };
}

describe('relay key log plaintext framing', () => {
  test('round trips fixed and variable length signatures', () => {
    for (const sigLength of [64, 7, 300]) {
      const source = entry(3, sigLength);
      const decoded = decodeRelayKeyLogPlaintext(encodeRelayKeyLogPlaintext(source));
      expect(decoded.bytes).toEqual(source.bytes);
      expect(decoded.sig).toEqual(source.sig);
    }
  });

  test('rejects non-JSON and missing fields', () => {
    expect(() => decodeRelayKeyLogPlaintext(new TextEncoder().encode('nope'))).toThrow(
      'not valid JSON'
    );
    expect(() => decodeRelayKeyLogPlaintext(new TextEncoder().encode('{"bytes":"AA"}'))).toThrow(
      'missing bytes/sig'
    );
  });
});

describe('openRelayKeyLogPage', () => {
  test('sorts by seq and opens every blob with K_log', async () => {
    const items = [await sealEntry(2, 20), await sealEntry(1, 10)];
    const opened = await openRelayKeyLogPage(KEY, items);
    expect(opened).toHaveLength(2);
    expect(opened[0].bytes).toEqual(entry(10).bytes);
    expect(opened[1].bytes).toEqual(entry(20).bytes);
  });

  test('accepts string seq (u64 wire form)', async () => {
    const first = await sealEntry(1, 10);
    const opened = await openRelayKeyLogPage(KEY, [{ seq: '1', blob: first.blob }]);
    expect(opened).toHaveLength(1);
  });

  test('rejects a gap in the sequence', async () => {
    const items = [await sealEntry(1, 10), await sealEntry(3, 30)];
    await expect(openRelayKeyLogPage(KEY, items)).rejects.toThrow('not contiguous at seq 3');
  });

  test('rejects a chain that does not start at 1', async () => {
    await expect(openRelayKeyLogPage(KEY, [await sealEntry(2, 20)])).rejects.toThrow(
      'not contiguous at seq 2'
    );
  });

  test('rejects blobs sealed with another tenant key', async () => {
    const other = generateTenantKey();
    const items = [
      { seq: 1, blob: await sealEnvelope(other, 'keylog', encodeRelayKeyLogPlaintext(entry(1))) },
    ];
    await expect(openRelayKeyLogPage(KEY, items)).rejects.toThrow();
  });
});

describe('parseRelayKeyLogPage', () => {
  test('returns an empty page for a missing field', () => {
    expect(parseRelayKeyLogPage(undefined)).toEqual([]);
  });

  test('rejects entries without seq or blob', () => {
    expect(() => parseRelayKeyLogPage([{ blob: {} }])).toThrow('missing seq');
    expect(() => parseRelayKeyLogPage([{ seq: 1 }])).toThrow('missing blob');
  });
});
