import { describe, expect, test } from 'bun:test';
import type { LocalAuthContext } from '../lib/local-auth';
import { handleRelayJoinRequest } from './relay-join-routes';
import { type SetupServiceDeps, createSetupTransitionLock } from './setup-service';

function deps(overrides: Partial<SetupServiceDeps> = {}): SetupServiceDeps {
  return {
    roles: { hub: false, node: false, relay: false },
    nodeEnv: 'test',
    auth: { userStore: { getByUsername: () => null } } as unknown as LocalAuthContext,
    envPath: '/tmp/app.env',
    installDir: '/tmp',
    scheduleRestart: () => undefined,
    setupLock: createSetupTransitionLock(),
    ...overrides,
  };
}

describe('handleRelayJoinRequest', () => {
  test('calls performRelayPasswordJoin with the body fields', async () => {
    let seen: unknown;
    const res = await handleRelayJoinRequest(
      {
        relayUrl: 'https://relay.example',
        tenantId: 'abc',
        password: 'tmex-test-pass',
        name: 'studio',
        caFingerprint: 'ab'.repeat(32),
        directEnable: false,
      },
      {
        ...deps(),
        performRelayPasswordJoin: async (input) => {
          seen = input;
          return { relayUrl: input.relayUrl, tenantId: input.tenantId, userId: 'alice' };
        },
      }
    );
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({
      relayUrl: 'https://relay.example',
      tenantId: 'abc',
      password: 'tmex-test-pass',
      name: 'studio',
      caFingerprint: 'ab'.repeat(32),
    });
  });
});
