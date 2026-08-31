import { describe, expect, test } from 'bun:test';
import { isAlreadyAtOrAboveLatest, mapForwardedUpgradeResponse } from './upgrade-service';

describe('isAlreadyAtOrAboveLatest', () => {
  test('same or newer parsed version is already latest', () => {
    expect(isAlreadyAtOrAboveLatest('1.2.3', '1.2.3')).toBe(true);
    expect(isAlreadyAtOrAboveLatest('1.2.4', '1.2.3')).toBe(true);
  });

  test('older version needs an upgrade', () => {
    expect(isAlreadyAtOrAboveLatest('1.2.2', '1.2.3')).toBe(false);
    expect(isAlreadyAtOrAboveLatest('1.1.0', '1.2.0')).toBe(false);
  });

  test('unparseable current versions are not treated as latest', () => {
    expect(isAlreadyAtOrAboveLatest('unknown', '1.2.3')).toBe(false);
    expect(isAlreadyAtOrAboveLatest('1.2.3_dev', '1.2.3')).toBe(false);
    expect(isAlreadyAtOrAboveLatest('', '1.2.3')).toBe(false);
    expect(isAlreadyAtOrAboveLatest(null, '1.2.3')).toBe(false);
  });
});

describe('mapForwardedUpgradeResponse', () => {
  const nodeId = 'ab'.repeat(16);

  test('404 → UPGRADE_UNSUPPORTED', async () => {
    const mapped = await mapForwardedUpgradeResponse(nodeId, new Response('gone', { status: 404 }));
    expect(mapped.status).toBe(404);
    expect(await mapped.json()).toEqual({ code: 'UPGRADE_UNSUPPORTED', nodeId });
  });

  test('403 → UPGRADE_NOT_ALLOWED', async () => {
    const mapped = await mapForwardedUpgradeResponse(
      nodeId,
      new Response(JSON.stringify({ error: 'no' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(mapped.status).toBe(403);
    expect(await mapped.json()).toEqual({ code: 'UPGRADE_NOT_ALLOWED', nodeId });
  });

  test('409 → UPGRADE_IN_PROGRESS and keeps target status fields', async () => {
    const mapped = await mapForwardedUpgradeResponse(
      nodeId,
      new Response(
        JSON.stringify({
          state: 'downloading',
          targetVersion: '9.9.9',
          error: 'busy',
          startedAt: '2026-08-30T00:00:00.000Z',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    );
    expect(mapped.status).toBe(409);
    expect(await mapped.json()).toEqual({
      code: 'UPGRADE_IN_PROGRESS',
      nodeId,
      state: 'downloading',
      targetVersion: '9.9.9',
      error: 'busy',
      startedAt: '2026-08-30T00:00:00.000Z',
    });
  });

  test('200 JSON status is passed through', async () => {
    const body = {
      state: 'downloading',
      targetVersion: '9.9.9',
      error: null,
      startedAt: '2026-08-30T00:00:00.000Z',
    };
    const upstream = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const mapped = await mapForwardedUpgradeResponse(nodeId, upstream);
    expect(mapped.status).toBe(200);
    expect(await mapped.json()).toEqual(body);
  });
});
