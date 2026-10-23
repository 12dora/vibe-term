import { describe, expect, test } from 'bun:test';
import {
  DIRECT_TRANSFER_STREAMS,
  RELAY_TRANSFER_STREAMS,
  pickTransferStreams,
} from './transfer-types';

describe('pickTransferStreams', () => {
  test('直连 4 条，经中继压到 2 条', () => {
    expect(pickTransferStreams(false)).toBe(DIRECT_TRANSFER_STREAMS);
    expect(pickTransferStreams(true)).toBe(RELAY_TRANSFER_STREAMS);
    expect([DIRECT_TRANSFER_STREAMS, RELAY_TRANSFER_STREAMS]).toEqual([4, 2]);
  });
});
