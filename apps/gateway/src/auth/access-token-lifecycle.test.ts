import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeExecSessionsWithInactiveToken,
  resetExecRegistryForTests,
} from '../exec/channel/registry';
import { makeEnv, openSession } from '../exec/channel/test-harness';
import { type TokenFixture, bootTokenFixture } from '../mesh/token-test-support';
import { startAccessTokenLifecycle, stopAccessTokenLifecycle } from './access-token-lifecycle';
import { isAccessTokenActive } from './access-tokens';

const DAY_MS = 86_400_000;

let fixture: TokenFixture;
beforeEach(() => {
  fixture = bootTokenFixture();
});
afterEach(() => {
  stopAccessTokenLifecycle();
  resetExecRegistryForTests();
  fixture.close();
});

describe('access token lifecycle', () => {
  test('revoking a token closes only the exec sessions of that token', async () => {
    startAccessTokenLifecycle();
    const env = makeEnv();
    const revoked = fixture.mint(['exec']);
    const kept = fixture.mint(['exec']);
    const a = await openSession(env, {}, { uid: 'tok-user', tokenId: revoked.id });
    const b = await openSession(env, {}, { uid: 'tok-user', tokenId: kept.id });
    const c = await openSession(env, {}, { uid: 'tok-user', tokenId: null });
    fixture.service.revoke('tok-user', revoked.id);
    expect(a.proc.killCount).toBe(1);
    expect(a.client.transport.closed?.code).toBe(4401);
    expect(b.proc.killCount).toBe(0);
    expect(c.proc.killCount).toBe(0);
  });

  test('stopping the lifecycle unsubscribes the revoke hook', async () => {
    startAccessTokenLifecycle();
    stopAccessTokenLifecycle();
    const env = makeEnv();
    const token = fixture.mint(['exec']);
    const a = await openSession(env, {}, { uid: 'tok-user', tokenId: token.id });
    fixture.service.revoke('tok-user', token.id);
    expect(a.proc.killCount).toBe(0);
  });

  test('the periodic recheck closes sessions whose token expired', async () => {
    const env = makeEnv();
    const short = fixture.mint(['exec'], 1);
    const long = fixture.mint(['exec'], 30);
    const a = await openSession(env, {}, { uid: 'tok-user', tokenId: short.id });
    const b = await openSession(env, {}, { uid: 'tok-user', tokenId: long.id });
    closeExecSessionsWithInactiveToken(isAccessTokenActive);
    expect(a.proc.killCount + b.proc.killCount).toBe(0);
    fixture.setNow(1_800_000_000_000 + 2 * DAY_MS);
    closeExecSessionsWithInactiveToken(isAccessTokenActive);
    expect(a.proc.killCount).toBe(1);
    expect(b.proc.killCount).toBe(0);
  });

  test('the recheck asks once per token and closes sessions of vanished tokens', async () => {
    const env = makeEnv();
    const a = await openSession(env, {}, { uid: 'u1', tokenId: 'gone' });
    const b = await openSession(env, {}, { uid: 'u1', tokenId: 'gone' });
    const c = await openSession(env, {}, { uid: 'u1', tokenId: null });
    const asked: string[] = [];
    closeExecSessionsWithInactiveToken((id) => {
      asked.push(id);
      return false;
    });
    expect(asked).toEqual(['gone']);
    expect(a.proc.killCount).toBe(1);
    expect(b.proc.killCount).toBe(1);
    expect(c.proc.killCount).toBe(0);
  });
});
