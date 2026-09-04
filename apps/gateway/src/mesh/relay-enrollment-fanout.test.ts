import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@tmex/shared/auth';
import type { StoredMeshRelayRow } from '../auth/mesh-relay-store';
import type { RelayDialContext } from './relay-dial';
import { type EnrollmentFanoutPayload, fanOutEnrollmentCreate } from './relay-enrollment-fanout';
import type { RelaySecrets } from './relay-secrets';

const ATTACHED = 'https://relay-attached.example';
const OTHER = 'https://relay-other.example';
const TENANT_A = 'aa'.repeat(16);
const TENANT_B = 'bb'.repeat(16);
const DIAL: RelayDialContext = { roles: { relay: false }, relayPublicUrl: null, gatewayPort: 0 };

function row(url: string, tenantId: string): StoredMeshRelayRow {
  return { url, tenantId, priority: 0, kicked: false };
}

function fakeSecrets(urls: string[]): RelaySecrets {
  return {
    store: {
      getRelay: async (url: string) => {
        if (!urls.includes(url)) return null;
        return {
          url,
          tenantId: url === ATTACHED ? TENANT_A : TENANT_B,
          token: new Uint8Array(32).fill(7),
          priority: 0,
          kicked: false,
        };
      },
    },
  } as unknown as RelaySecrets;
}

function payload(): EnrollmentFanoutPayload {
  return {
    id: 'enr-1',
    enrollPk: new Uint8Array(32).fill(1),
    authorization: new Uint8Array(8).fill(2),
    authorizationSig: new Uint8Array(64).fill(3),
    exp: Date.now() + 300_000,
  };
}

function jsonError(status: number, code?: string): Response {
  return new Response(code ? JSON.stringify({ error: { code, message: code } }) : '{}', {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fanOutEnrollmentCreate HTTP capability miss', () => {
  test('attached relay 404/405 and RELAY_NOT_FOUND fall back to uplink', async () => {
    const cases: Array<{ status: number; code?: string }> = [
      { status: 404 },
      { status: 405 },
      { status: 404, code: 'RELAY_NOT_FOUND' },
      { status: 405, code: 'RELAY_METHOD_NOT_ALLOWED' },
    ];
    for (const item of cases) {
      let uplink = 0;
      const results = await fanOutEnrollmentCreate({
        secrets: fakeSecrets([ATTACHED]),
        rows: [row(ATTACHED, TENANT_A)],
        payload: payload(),
        fetchImpl: (async () => jsonError(item.status, item.code)) as unknown as typeof fetch,
        dial: DIAL,
        timeoutMs: 1_000,
        attachedUrl: ATTACHED,
        uplinkCreate: async () => {
          uplink += 1;
          return { ok: true };
        },
      });
      expect(uplink).toBe(1);
      expect(results).toEqual([
        {
          url: ATTACHED,
          tenantId: TENANT_A,
          token: encodeBase64url(new Uint8Array(32).fill(7)),
          accepted: true,
        },
      ]);
    }
  });

  test('non-attached relay 404 stays accepted false', async () => {
    let uplink = 0;
    const results = await fanOutEnrollmentCreate({
      secrets: fakeSecrets([ATTACHED, OTHER]),
      rows: [row(OTHER, TENANT_B)],
      payload: payload(),
      fetchImpl: (async () => jsonError(404, 'RELAY_NOT_FOUND')) as unknown as typeof fetch,
      dial: DIAL,
      timeoutMs: 1_000,
      attachedUrl: ATTACHED,
      uplinkCreate: async () => {
        uplink += 1;
        return { ok: true };
      },
    });
    expect(uplink).toBe(0);
    expect(results).toEqual([
      { url: OTHER, tenantId: TENANT_B, accepted: false, error: 'RELAY_NOT_FOUND' },
    ]);
  });
});
