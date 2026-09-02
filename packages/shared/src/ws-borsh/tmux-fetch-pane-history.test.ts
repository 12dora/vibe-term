import { describe, expect, test } from 'bun:test';
import { decodePayload, encodePayload } from './codec';
import {
  TmuxFetchPaneHistoryLegacySchema,
  TmuxFetchPaneHistorySchema,
  decodeTmuxFetchPaneHistory,
} from './schema';

const TOKEN = new Uint8Array(16).fill(7);

describe('TmuxFetchPaneHistorySchema byteLimit', () => {
  test('round-trips an explicit byteLimit', () => {
    const encoded = encodePayload(TmuxFetchPaneHistorySchema, {
      deviceId: 'dev-1',
      paneId: '%1',
      requestToken: TOKEN,
      byteLimit: 262144,
    });
    expect(decodeTmuxFetchPaneHistory(encoded)).toEqual({
      deviceId: 'dev-1',
      paneId: '%1',
      requestToken: TOKEN,
      byteLimit: 262144,
    });
  });

  test('legacy 3-field payloads still decode with byteLimit null', () => {
    const encoded = encodePayload(TmuxFetchPaneHistoryLegacySchema, {
      deviceId: 'dev-1',
      paneId: '%2',
      requestToken: TOKEN,
    });
    expect(decodeTmuxFetchPaneHistory(encoded)).toEqual({
      deviceId: 'dev-1',
      paneId: '%2',
      requestToken: TOKEN,
      byteLimit: null,
    });
  });

  test('old targets that ignore trailing bytes can still decode a new payload', () => {
    const encoded = encodePayload(TmuxFetchPaneHistorySchema, {
      deviceId: 'dev-1',
      paneId: '%3',
      requestToken: TOKEN,
      byteLimit: 4096,
    });
    const decoded = decodePayload(TmuxFetchPaneHistoryLegacySchema, encoded);
    expect(decoded.deviceId).toBe('dev-1');
    expect(decoded.paneId).toBe('%3');
    expect(decoded.requestToken).toEqual(TOKEN);
  });
});
