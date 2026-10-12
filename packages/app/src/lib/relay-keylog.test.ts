import { describe, expect, test } from 'bun:test';
import {
  decodeRelayKeyLogPlaintext,
  encodeRelayKeyLogPlaintext,
  generateTenantKey,
  sealEnvelope,
} from '../../../shared/src/relay';
import { RelayTransportError } from '../commands/relay-shared';
import type { FetchLike } from './fetch-like';
import { fetchRelayKeyLog, openRelayKeyLogPage, parseRelayKeyLogPage } from './relay-keylog';

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

describe('openRelayKeyLogPage from a later seq', () => {
  test('accepts a contiguous page that starts at firstSeq', async () => {
    const items = [await sealEntry(4, 40), await sealEntry(3, 30)];
    const opened = await openRelayKeyLogPage(KEY, items, 3n);
    expect(opened.map((record) => record.bytes[0])).toEqual([30, 40]);
  });

  test('rejects a page that skips firstSeq', async () => {
    await expect(openRelayKeyLogPage(KEY, [await sealEntry(4, 40)], 3n)).rejects.toThrow(
      'not contiguous at seq 4'
    );
  });
});

describe('fetchRelayKeyLog', () => {
  const base = { relayUrl: 'https://relay.example', tenantId: 'ab'.repeat(16), logKey: KEY };

  test('follows has_more from from_seq and sends the given headers', async () => {
    const seen: { from: string | null; headers: unknown }[] = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      const from = url.searchParams.get('from_seq');
      seen.push({ from, headers: init?.headers });
      if (from === '3') {
        return Response.json({
          key_log: [await sealEntry(3, 30), await sealEntry(4, 40)],
          has_more: true,
        });
      }
      return Response.json({ key_log: [await sealEntry(5, 50)], has_more: false });
    };

    const opened = await fetchRelayKeyLog({
      ...base,
      headers: { 'x-test': '1' },
      fromSeq: 3,
      fetcher,
    });

    expect(opened.map((record) => record.bytes[0])).toEqual([30, 40, 50]);
    expect(seen.map((call) => call.from)).toEqual(['3', '5']);
    expect(seen[0].headers).toEqual({ 'x-test': '1' });
  });

  test('defaults to seq 1 and returns nothing for an empty log', async () => {
    const froms: (string | null)[] = [];
    const fetcher: FetchLike = async (input) => {
      froms.push(new URL(String(input)).searchParams.get('from_seq'));
      return Response.json({ key_log: [], has_more: false });
    };
    expect(await fetchRelayKeyLog({ ...base, headers: {}, fetcher })).toEqual([]);
    expect(froms).toEqual(['1']);
  });

  test('refuses a page that does not start at from_seq', async () => {
    const fetcher: FetchLike = async () =>
      Response.json({ key_log: [await sealEntry(4, 40)], has_more: false });
    await expect(fetchRelayKeyLog({ ...base, headers: {}, fromSeq: 3, fetcher })).rejects.toThrow(
      'not contiguous at seq 4'
    );
  });

  test('aborting the signal cancels the request that is in flight', async () => {
    const controller = new AbortController();
    let aborted = false;
    const fetcher: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });

    const pending = fetchRelayKeyLog({
      ...base,
      headers: {},
      fetcher,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    controller.abort();
    const error = await pending;

    expect(aborted).toBe(true);
    expect(error).not.toBeInstanceOf(RelayTransportError);
  });
});
