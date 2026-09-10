import { describe, expect, test } from 'bun:test';
import type { Carrier, CarrierKind } from './carrier';
import { carrierKindOf } from './ws-backpressure-log';

function stub(kind?: CarrierKind): Carrier {
  return {
    ...(kind ? { logContext: { kind } } : {}),
    send: () => 'sent',
    bufferedAmount: () => 0,
    onDrain: () => {},
    close: () => {},
    terminate: () => {},
  };
}

describe('carrierKindOf', () => {
  test('reads logContext.kind and falls back to unknown', () => {
    expect(carrierKindOf(stub('physical_browser_ws'))).toBe('physical_browser_ws');
    expect(carrierKindOf(stub('mesh_link_stream'))).toBe('mesh_link_stream');
    expect(carrierKindOf(stub('webrtc_dc'))).toBe('webrtc_dc');
    expect(carrierKindOf(stub())).toBe('unknown');
  });
});
