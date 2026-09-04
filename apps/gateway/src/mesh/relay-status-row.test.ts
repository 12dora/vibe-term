import { describe, expect, test } from 'bun:test';
import { buildRelayStatusRow, relayLinkError } from './relay-status-row';

describe('relayLinkError', () => {
  test('attached row uses the live client error, not the pool candidate', () => {
    expect(
      relayLinkError({
        attached: true,
        clientError: { reason: 'bad-token', at: 9 },
        candidate: { lastError: 'stale-pool', lastErrorAt: 1 },
      })
    ).toEqual({ lastError: 'bad-token', lastErrorAt: 9 });
    expect(
      relayLinkError({
        attached: true,
        clientError: null,
        candidate: { lastError: 'stale-pool', lastErrorAt: 1 },
      })
    ).toEqual({ lastError: null, lastErrorAt: null });
  });

  test('unattached row uses the pool candidate failure', () => {
    expect(
      relayLinkError({
        attached: false,
        clientError: { reason: 'other', at: 3 },
        candidate: { lastError: 'member-epoch_mismatch', lastErrorAt: 42 },
      })
    ).toEqual({ lastError: 'member-epoch_mismatch', lastErrorAt: 42 });
    expect(relayLinkError({ attached: false, clientError: null, candidate: null })).toEqual({
      lastError: null,
      lastErrorAt: null,
    });
  });
});

describe('buildRelayStatusRow', () => {
  test('fills lastError from the matching unattached candidate', () => {
    const row = buildRelayStatusRow(
      { url: 'https://b.example', priority: 1, kicked: false },
      'https://a.example',
      null,
      null,
      [{ publicUrl: 'https://b.example', lastError: 'client-too-old', lastErrorAt: 7 }]
    );
    expect(row).toMatchObject({
      url: 'https://b.example',
      attached: false,
      online: false,
      lastError: 'client-too-old',
      lastErrorAt: 7,
    });
  });
});
