import { describe, expect, test } from 'bun:test';
import type { RelayStatusPayload, RelayStatusRow } from './status-row';

const ROW: RelayStatusRow = {
  url: 'https://sh.example',
  priority: 0,
  online: true,
  attached: true,
  role: 'primary',
  rttMs: 12,
  peersOnline: 3,
  turn: { url: 'turn:sh.example:3478', probeOk: true },
  lastError: null,
  lastErrorCode: null,
  lastErrorAt: null,
  kicked: false,
  kickedReason: null,
};

describe('RelayStatusRow JSON', () => {
  test('canonical row serializes with stable key order', () => {
    expect(JSON.stringify(ROW)).toBe(
      '{"url":"https://sh.example","priority":0,"online":true,"attached":true,"role":"primary","rttMs":12,"peersOnline":3,"turn":{"url":"turn:sh.example:3478","probeOk":true},"lastError":null,"lastErrorCode":null,"lastErrorAt":null,"kicked":false,"kickedReason":null}'
    );
  });

  test('payload envelope keeps relays as an array of rows', () => {
    const payload: RelayStatusPayload = {
      mode: 'relay',
      tenantId: 'ab'.repeat(16),
      relays: [ROW],
      metaEpoch: 1,
      nodesViaRelay: 3,
      multiAttach: false,
      reauthRequired: false,
      awaitingToken: false,
      readmitPending: 0,
      metaKeyLagging: [],
      quota: null,
      keyLog: { skipped: 0, blockedSeq: null, caughtUp: true },
    };
    const parsed = JSON.parse(JSON.stringify(payload)) as RelayStatusPayload;
    expect(parsed.relays[0]?.url).toBe(ROW.url);
    expect(parsed.relays[0]?.lastErrorCode).toBeNull();
  });
});
