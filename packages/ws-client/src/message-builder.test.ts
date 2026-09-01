import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { buildTermViewportMessage } from './message-builder';

describe('buildTermViewportMessage', () => {
  test('encodes KIND_TERM_VIEWPORT with geometry and visibility', () => {
    const message = buildTermViewportMessage({
      deviceId: 'dev-1',
      paneId: '%0',
      cols: 80,
      rows: 24,
      visible: true,
    });
    expect(message.kind).toBe(wsBorsh.KIND_TERM_VIEWPORT);
    expect(wsBorsh.decodePayload(wsBorsh.schema.TermViewportSchema, message.payload)).toEqual({
      deviceId: 'dev-1',
      paneId: '%0',
      cols: 80,
      rows: 24,
      visible: true,
    });
  });
});
