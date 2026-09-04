import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  encodeSetRelaysPayload,
  genesisHead,
} from '@tmex/shared/auth';
import { planKeyLogAppend } from './auth-key-log-routes';

function recordBytes(type: 'readmit-node' | 'admit-node' | 'set-relays'): Uint8Array {
  const payload =
    type === 'set-relays'
      ? encodeSetRelaysPayload({
          mode: 'ordered',
          relays: [],
          log_key: [],
          meta_key: { epoch: 1, entries: [] },
        })
      : encodeAdmitNodePayload({
          authorization_bytes: new Uint8Array(4),
          authorization_sig: new Uint8Array(64),
          certificate_bytes: new Uint8Array(4),
          cert_sig: new Uint8Array(64),
        });
  return encodeKeyLogRecord(
    buildKeyLogRecord(genesisHead(), 0, {
      uid: 'user-1',
      type,
      payload,
      signer: 'root',
      credential_id: null,
    })
  );
}

describe('planKeyLogAppend readmit-node', () => {
  test('hub 模式走 writer，中继模式 local-first + publish', () => {
    const bytes = recordBytes('readmit-node');
    expect(planKeyLogAppend({ relayMode: false, bytes })).toEqual({
      localFirst: false,
      publish: true,
    });
    expect(planKeyLogAppend({ relayMode: true, bytes })).toEqual({
      localFirst: true,
      publish: true,
    });
    expect(planKeyLogAppend({ relayMode: false, bytes: recordBytes('admit-node') })).toEqual({
      localFirst: false,
      publish: true,
    });
    expect(planKeyLogAppend({ relayMode: false, bytes: recordBytes('set-relays') })).toEqual({
      localFirst: true,
      publish: false,
    });
  });
});
