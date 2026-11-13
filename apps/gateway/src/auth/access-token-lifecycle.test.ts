import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeExecSessionsWithInactiveToken,
  resetExecRegistryForTests,
} from '../exec/channel/registry';
import { connect, makeEnv, openSession } from '../exec/channel/test-harness';
import { TOKEN_USER, type TokenFixture, bootTokenFixture } from '../mesh/token-test-support';
import { PortMapExportStore, PortMapStore } from '../portmap/store';
import type { PortMapRow } from '../portmap/types';
import {
  startAccessTokenLifecycle,
  stopAccessTokenLifecycle,
  teardownInactiveTokens,
} from './access-token-lifecycle';
import { isAccessTokenActive } from './access-tokens';

const DAY_MS = 86_400_000;

function mapRow(id: string, createdByTokenId?: string): PortMapRow {
  return {
    id,
    name: id,
    listenHost: '127.0.0.1',
    listenPort: 15_432,
    targetNodeId: 'd'.repeat(32),
    targetHost: '127.0.0.1',
    targetPort: 5432,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    ...(createdByTokenId ? { createdByTokenId } : {}),
  };
}

function seedPortMaps(fixture: TokenFixture, tokenIds: string[]) {
  const maps = new PortMapStore(fixture.service.db);
  const exports = new PortMapExportStore(fixture.service.db);
  for (const tokenId of tokenIds) {
    maps.insert(mapRow(`map-${tokenId}`, tokenId));
    exports.insert({
      mapId: `exp-${tokenId}`,
      fromNodeId: 'd'.repeat(32),
      host: '10.0.0.5',
      port: 22,
      enabled: true,
      createdAt: 1,
      createdByTokenId: tokenId,
    });
  }
  maps.insert(mapRow('map-session'));
  return {
    maps: () => maps.list().map((row) => row.id),
    exports: () => exports.list().map((row) => row.mapId),
  };
}

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

  test('revoking a token also closes its connection that has not sent HELLO yet', () => {
    startAccessTokenLifecycle();
    const env = makeEnv();
    const revoked = fixture.mint(['exec']);
    const kept = fixture.mint(['exec']);
    const a = connect(env, { uid: 'tok-user', tokenId: revoked.id });
    const b = connect(env, { uid: 'tok-user', tokenId: kept.id });
    fixture.service.revoke('tok-user', revoked.id);
    expect(a.transport.closed?.code).toBe(4401);
    expect(b.transport.closed).toBeNull();
  });

  test('revoking every token of a user closes their sessions and pre-HELLO connections', async () => {
    startAccessTokenLifecycle();
    const env = makeEnv();
    const first = fixture.mint(['exec']);
    const second = fixture.mint(['exec']);
    const session = await openSession(env, {}, { uid: 'tok-user', tokenId: first.id });
    const pending = connect(env, { uid: 'tok-user', tokenId: second.id });
    expect(fixture.service.revokeAllForUser('tok-user')).toBe(2);
    expect(session.proc.killCount).toBe(1);
    expect(session.client.transport.closed?.code).toBe(4401);
    expect(pending.transport.closed?.code).toBe(4401);
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

  test('revoking the tokens issued through a revoked entry closes their exec sessions', async () => {
    startAccessTokenLifecycle();
    const env = makeEnv();
    const entry = 'a'.repeat(32);
    const viaEntry = fixture.service.create(
      TOKEN_USER,
      { name: 'ci', scopes: ['exec'], expiresInDays: null },
      null,
      entry
    ).token.id;
    const local = fixture.mint(['exec']);
    const a = await openSession(env, {}, { uid: TOKEN_USER, tokenId: viaEntry });
    const b = await openSession(env, {}, { uid: TOKEN_USER, tokenId: local.id });
    expect(fixture.service.revokeIssuedVia(entry)).toBe(1);
    expect(a.proc.killCount).toBe(1);
    expect(a.client.transport.closed?.code).toBe(4401);
    expect(b.proc.killCount).toBe(0);
  });

  test('revoking a token removes the port maps and exports it created', () => {
    startAccessTokenLifecycle();
    const revoked = fixture.mint(['forward']);
    const kept = fixture.mint(['forward']);
    const rows = seedPortMaps(fixture, [revoked.id, kept.id]);
    fixture.service.revoke(TOKEN_USER, revoked.id);
    expect(rows.maps().sort()).toEqual([`map-${kept.id}`, 'map-session'].sort());
    expect(rows.exports()).toEqual([`exp-${kept.id}`]);
  });

  test('the recheck removes port maps of expired or vanished tokens', () => {
    const short = fixture.mint(['forward'], 1);
    const long = fixture.mint(['forward'], 30);
    const rows = seedPortMaps(fixture, [short.id, long.id, 'vanished']);
    teardownInactiveTokens();
    expect(rows.maps()).toHaveLength(3);
    expect(rows.maps()).not.toContain('map-vanished');
    fixture.setNow(1_800_000_000_000 + 2 * DAY_MS);
    teardownInactiveTokens();
    expect(rows.maps().sort()).toEqual([`map-${long.id}`, 'map-session'].sort());
    expect(rows.exports()).toEqual([`exp-${long.id}`]);
  });
});
