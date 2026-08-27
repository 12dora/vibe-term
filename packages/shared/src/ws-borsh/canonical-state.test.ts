import { describe, expect, test } from 'bun:test';

import { assertCanonicalEncoding, canonicalScanSupportsNode } from './canonical-scan';
import {
  type CanonicalCommand,
  CanonicalCommandEnvelopeSchema,
  type CanonicalEvent,
  CanonicalEventEnvelopeSchema,
  decodeCanonicalCommandPayload,
  decodeCanonicalEventPayload,
  encodeCanonicalCommandPayload,
  encodeCanonicalEventPayload,
} from './canonical-state';
import { WsBorshError } from './errors';

const ZERO_16 = new Uint8Array(16);
const PANE = { deviceId: 'device-a', serverEpoch: ZERO_16, paneId: '%1' };

interface SchemaNode {
  readonly type: string;
  readonly options: unknown;
}

function paneDataEvent(data: Uint8Array): CanonicalEvent {
  return {
    PaneData: {
      pane: PANE,
      paneEpoch: ZERO_16,
      seqStart: 10n,
      seqEnd: 10n + BigInt(data.byteLength),
      data,
    },
  };
}

function corruptPaneDataSeqEnd(
  payload: Uint8Array,
  dataLength: number,
  seqEnd: bigint
): Uint8Array {
  const corrupted = payload.slice();
  const offset = corrupted.byteLength - dataLength - 4 - 8;
  new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength).setBigUint64(
    offset,
    seqEnd,
    true
  );
  return corrupted;
}

function reencodeIsCanonical<T>(
  schema: { serialize(value: T): Uint8Array; deserialize(payload: Uint8Array): T },
  payload: Uint8Array
): boolean {
  const canonical = schema.serialize(schema.deserialize(payload));
  return (
    canonical.byteLength === payload.byteLength &&
    !canonical.some((byte, index) => byte !== payload[index])
  );
}

function scanIsCanonical(schema: SchemaNode, payload: Uint8Array): boolean {
  try {
    assertCanonicalEncoding(schema, payload);
    return true;
  } catch (error) {
    if (error instanceof WsBorshError) return false;
    throw error;
  }
}

function collectNodeTypes(node: SchemaNode, seen: Set<string>): void {
  seen.add(node.type);
  const options = node.options;
  if (typeof options !== 'object' || options === null) return;
  const record = options as Record<string, unknown>;
  if (node.type === 'struct') {
    for (const field of Object.values(record)) collectNodeTypes(field as SchemaNode, seen);
    return;
  }
  if (node.type === 'enum' && Array.isArray(record.variants)) {
    for (const variant of record.variants) collectNodeTypes(variant as SchemaNode, seen);
    return;
  }
  if (node.type === 'vec') {
    collectNodeTypes({ type: String(record.elementType), options: record.elementOptions }, seen);
    return;
  }
  if (node.type === 'option') {
    collectNodeTypes({ type: String(record.valueType), options: record.valueOptions }, seen);
  }
}

function mutations(payload: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [Uint8Array.from([...payload, 0]), payload.slice(0, -1)];
  for (let index = 0; index < payload.byteLength; index += 1) {
    for (const value of [0x00, 0x01, 0x02, 0x80, 0xfe]) {
      if (payload[index] === value) continue;
      const mutated = payload.slice();
      mutated[index] = value;
      result.push(mutated);
    }
  }
  return result;
}

describe('canonical event semantics', () => {
  test('decode rejects raw payloads whose PaneData range mismatches the data length', () => {
    const data = new Uint8Array([1, 2, 3]);
    const payload = encodeCanonicalEventPayload(paneDataEvent(data));
    expect(decodeCanonicalEventPayload(payload).event).toEqual(paneDataEvent(data));

    const tooLong = corruptPaneDataSeqEnd(payload, data.byteLength, 99n);
    expect(() => decodeCanonicalEventPayload(tooLong)).toThrow(WsBorshError);
    expect(() => decodeCanonicalEventPayload(tooLong)).toThrow('PaneData sequence range mismatch');

    const inverted = corruptPaneDataSeqEnd(payload, data.byteLength, 9n);
    expect(() => decodeCanonicalEventPayload(inverted)).toThrow(WsBorshError);

    const empty = encodeCanonicalEventPayload(paneDataEvent(new Uint8Array()));
    expect(() => decodeCanonicalEventPayload(corruptPaneDataSeqEnd(empty, 0, 11n))).toThrow(
      WsBorshError
    );
  });

  test('encode still rejects mismatched PaneData ranges', () => {
    expect(() =>
      encodeCanonicalEventPayload({
        PaneData: {
          pane: PANE,
          paneEpoch: ZERO_16,
          seqStart: 10n,
          seqEnd: 12n,
          data: new Uint8Array([1]),
        },
      })
    ).toThrow(WsBorshError);
  });
});

describe('canonical encoding scan', () => {
  const command: CanonicalCommand = {
    RequestHistory: {
      requestId: ZERO_16,
      pane: PANE,
      beforeCursor: { paneEpoch: ZERO_16, historyEpoch: ZERO_16, beforeLine: 7 },
      byteLimit: 4096,
    },
  };
  const errorEvent: CanonicalEvent = {
    Error: { requestId: null, code: 3, message: '错误 message', retryable: true },
  };

  test('covers every schema node reachable from the canonical envelopes', () => {
    const seen = new Set<string>();
    collectNodeTypes(CanonicalCommandEnvelopeSchema, seen);
    collectNodeTypes(CanonicalEventEnvelopeSchema, seen);
    expect(seen.size).toBeGreaterThan(5);
    for (const type of seen) {
      expect([type, canonicalScanSupportsNode(type)]).toEqual([type, true]);
    }
  });

  test('rejects the known malformed encoding families', () => {
    const payload = encodeCanonicalEventPayload(errorEvent);
    const withTrailing = Uint8Array.from([...payload, 0]);
    expect(() => decodeCanonicalEventPayload(withTrailing)).toThrow(WsBorshError);

    const nonCanonicalBool = payload.slice();
    nonCanonicalBool[nonCanonicalBool.byteLength - 1] = 2;
    expect(() => decodeCanonicalEventPayload(nonCanonicalBool)).toThrow(WsBorshError);

    const nonCanonicalOption = payload.slice();
    nonCanonicalOption[3] = 2;
    expect(() => decodeCanonicalEventPayload(nonCanonicalOption)).toThrow(WsBorshError);

    const badStringLength = payload.slice();
    badStringLength[6] = 3;
    expect(() => decodeCanonicalEventPayload(badStringLength)).toThrow(WsBorshError);

    const badUtf8 = payload.slice();
    badUtf8[10] = 0xff;
    expect(() => decodeCanonicalEventPayload(badUtf8)).toThrow(WsBorshError);

    const badEnumTag = payload.slice();
    badEnumTag[2] = 99;
    expect(() => decodeCanonicalEventPayload(badEnumTag)).toThrow(WsBorshError);

    const truncated = payload.slice(0, -1);
    expect(() => decodeCanonicalEventPayload(truncated)).toThrow(WsBorshError);
  });

  test('accepts or rejects exactly what the re-encode comparison did', () => {
    const cases: Array<[SchemaNode, Uint8Array]> = [
      [CanonicalCommandEnvelopeSchema, encodeCanonicalCommandPayload(command)],
      [
        CanonicalCommandEnvelopeSchema,
        encodeCanonicalCommandPayload({
          SetPaneSubscriptions: {
            generation: 5n,
            activePanes: [{ pane: PANE, cursor: { paneEpoch: ZERO_16, terminalSeq: 2n } }],
            hotPanes: [{ pane: PANE, cursor: null }],
          },
        }),
      ],
      [CanonicalEventEnvelopeSchema, encodeCanonicalEventPayload(errorEvent)],
      [CanonicalEventEnvelopeSchema, encodeCanonicalEventPayload(paneDataEvent(new Uint8Array(9)))],
      [
        CanonicalEventEnvelopeSchema,
        encodeCanonicalEventPayload({
          SourceGap: { reason: 2, scope: { Stream: {} } },
        }),
      ],
    ];

    let decodable = 0;
    let rejected = 0;
    for (const [schema, payload] of cases) {
      for (const candidate of mutations(payload)) {
        let reencoded: boolean;
        try {
          reencoded = reencodeIsCanonical(
            schema as unknown as {
              serialize(value: unknown): Uint8Array;
              deserialize(payload: Uint8Array): unknown;
            },
            candidate
          );
        } catch {
          continue;
        }
        decodable += 1;
        if (!reencoded) rejected += 1;
        expect([candidate.byteLength, scanIsCanonical(schema, candidate)]).toEqual([
          candidate.byteLength,
          reencoded,
        ]);
      }
    }
    expect(decodable).toBeGreaterThan(200);
    expect(rejected).toBeGreaterThan(100);
  });

  test('round-trips valid commands and events through the scan', () => {
    const commandPayload = encodeCanonicalCommandPayload(command);
    expect(decodeCanonicalCommandPayload(commandPayload).command).toEqual(command);
    const eventPayload = encodeCanonicalEventPayload(errorEvent);
    expect(decodeCanonicalEventPayload(eventPayload).event).toEqual(errorEvent);
  });
});
