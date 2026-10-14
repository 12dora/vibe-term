import { afterEach, describe, expect, test } from 'bun:test';
import { EC_DEAD_MS, EcKind, type ExecReady } from '@vibeterm/shared/exec-channel';
import {
  closeExecSessionsForSid,
  closeExecSessionsForToken,
  closeExecSessionsWithInactiveToken,
  closeExecSessionsWithInvalidSession,
  getSession,
  liveSessionCount,
  resetExecRegistryForTests,
} from './registry';
import { FakeProcess, connect, flush, makeEnv, openSession, openSpec } from './test-harness';

afterEach(() => resetExecRegistryForTests());

const ref = (sid: string, viaNodeId = 'self') => ({ sid, viaNodeId });
const errorCode = (c: { transport: { json<T>(kind: number): T[] } }) =>
  c.transport.json<{ code: string }>(EcKind.ERROR)[0]?.code;

function sendOpen(c: ReturnType<typeof connect>) {
  c.send(EcKind.HELLO, { v: 1, op: 'open', spec: openSpec() });
}

function sendResume(c: ReturnType<typeof connect>, sessionId: string) {
  c.send(EcKind.HELLO, { v: 1, op: 'resume', sessionId, out: 0 });
}

describe('connections waiting for HELLO', () => {
  test('revoking the token closes the idle connection before any process spawns', async () => {
    const env = makeEnv();
    const c = connect(env, { uid: 'u1', tokenId: 'T' });
    const other = connect(env, { uid: 'u1', tokenId: 'T2' });
    closeExecSessionsForToken('T');
    expect(c.transport.closed?.code).toBe(4401);
    expect(other.transport.closed).toBeNull();
    sendOpen(c);
    await flush();
    expect(env.procs.length).toBe(0);
    expect(liveSessionCount()).toBe(0);
  });

  test('the token recheck closes pre-HELLO connections of inactive tokens only once per token', () => {
    const env = makeEnv();
    const a = connect(env, { uid: 'u1', tokenId: 'gone' });
    const b = connect(env, { uid: 'u1', tokenId: 'gone' });
    const kept = connect(env, { uid: 'u1', tokenId: 'live' });
    const sessionAuth = connect(env, { uid: 'u1', tokenId: null });
    const asked: string[] = [];
    closeExecSessionsWithInactiveToken((id) => {
      asked.push(id);
      return id === 'live';
    });
    expect(asked.sort()).toEqual(['gone', 'live']);
    expect(a.transport.closed?.code).toBe(4401);
    expect(b.transport.closed?.code).toBe(4401);
    expect(kept.transport.closed).toBeNull();
    expect(sessionAuth.transport.closed).toBeNull();
  });

  test('sid revocation and the session recheck close pre-HELLO connections', () => {
    const env = makeEnv();
    const a = connect(env, { uid: 'u1', tokenId: null, session: ref('s1') });
    const b = connect(env, { uid: 'u1', tokenId: null, session: ref('s2', 'peer') });
    const c = connect(env, { uid: 'u1', tokenId: null, session: ref('s3') });
    closeExecSessionsForSid('s1');
    expect(a.transport.closed?.code).toBe(4401);
    closeExecSessionsWithInvalidSession((r) => r.sid === 's2');
    expect(b.transport.closed).toBeNull();
    expect(c.transport.closed?.code).toBe(4401);
  });

  test('a closed connection leaves the registry (no later revoke touches its transport)', () => {
    const env = makeEnv();
    const c = connect(env, { uid: 'u1', tokenId: 'T' });
    c.inbound.onClose();
    closeExecSessionsForToken('T');
    expect(c.transport.closed).toBeNull();
  });

  test('an idle connection is still dropped by the dead timer without leaking', async () => {
    const env = makeEnv();
    const c = connect(env, { uid: 'u1', tokenId: 'T' });
    await env.clock.advance(EC_DEAD_MS + 1000);
    expect(c.transport.closed?.code).toBe(4408);
    closeExecSessionsForToken('T');
    expect(c.transport.closed?.code).toBe(4408);
  });

  test('revoking while the process is still spawning kills it', async () => {
    const env = makeEnv();
    const proc = new FakeProcess();
    let release: (() => void) | null = null;
    env.deps.spawn = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return proc;
    };
    const c = connect(env, { uid: 'u1', tokenId: 'T' });
    sendOpen(c);
    await flush();
    closeExecSessionsForToken('T');
    (release as (() => void) | null)?.();
    await flush();
    expect(proc.killCount).toBe(1);
    expect(liveSessionCount()).toBe(0);
    expect(c.transport.json(EcKind.READY).length).toBe(0);
  });
});

describe('HELLO credential recheck', () => {
  test('open is rejected when the credential was revoked before HELLO', async () => {
    const env = makeEnv();
    const c = connect(env, { uid: 'u1', tokenId: 'T' });
    env.credential.valid = false;
    await env.clock.advance(44_000);
    expect(c.transport.closed).toBeNull();
    sendOpen(c);
    await flush();
    expect(c.transport.closed?.code).toBe(4401);
    expect(c.transport.json(EcKind.READY).length).toBe(0);
    expect(env.procs.length).toBe(0);
    expect(liveSessionCount()).toBe(0);
  });

  test('resume is rejected with the same check and leaves the session running', async () => {
    const env = makeEnv();
    const { client, sessionId, proc } = await openSession(env, {}, { uid: 'u1', tokenId: 'T' });
    client.inbound.onClose();
    env.credential.valid = false;
    const b = connect(env, { uid: 'u1', tokenId: 'T' });
    sendResume(b, sessionId);
    await flush();
    expect(b.transport.closed?.code).toBe(4401);
    expect(b.transport.json(EcKind.READY).length).toBe(0);
    expect(getSession(sessionId)).toBeDefined();
    expect(proc.killCount).toBe(0);
  });

  test('the check receives the connection auth (token id and session ref)', async () => {
    const env = makeEnv();
    const seen: unknown[] = [];
    env.deps.credentialValid = (auth) => {
      seen.push(auth);
      return true;
    };
    const auth = { uid: 'u1', tokenId: null, session: ref('s1') };
    await openSession(env, {}, auth);
    expect(seen).toEqual([auth]);
  });
});

describe('resume requires the creating credential', () => {
  test('a different token gets session_not_found and cannot take the session over', async () => {
    const env = makeEnv();
    const { client, sessionId } = await openSession(env, {}, { uid: 'u1', tokenId: 'T1' });
    client.inbound.onClose();
    const b = connect(env, { uid: 'u1', tokenId: 'T2' });
    sendResume(b, sessionId);
    await flush();
    expect(errorCode(b)).toBe('session_not_found');
    expect(b.transport.json(EcKind.READY).length).toBe(0);
    closeExecSessionsForToken('T2');
    expect(getSession(sessionId)).toBeDefined();
  });

  test('a token cannot resume a browser-session exec session, nor the reverse', async () => {
    const env = makeEnv();
    const viaSession = await openSession(env, {}, { uid: 'u1', tokenId: null, session: ref('s1') });
    const viaToken = await openSession(env, {}, { uid: 'u1', tokenId: 'T1' });
    viaSession.client.inbound.onClose();
    viaToken.client.inbound.onClose();
    const a = connect(env, { uid: 'u1', tokenId: 'T1' });
    sendResume(a, viaSession.sessionId);
    const b = connect(env, { uid: 'u1', tokenId: null, session: ref('s1') });
    sendResume(b, viaToken.sessionId);
    await flush();
    expect(errorCode(a)).toBe('session_not_found');
    expect(errorCode(b)).toBe('session_not_found');
  });

  test('the same token resumes, and revoking it closes the resumed connection and session', async () => {
    const env = makeEnv();
    const { client, sessionId, proc } = await openSession(env, {}, { uid: 'u1', tokenId: 'T1' });
    client.inbound.onClose();
    const b = connect(env, { uid: 'u1', tokenId: 'T1' });
    sendResume(b, sessionId);
    await flush();
    expect(b.transport.json<ExecReady>(EcKind.READY)[0]).toMatchObject({ resumed: true });
    closeExecSessionsForToken('T1');
    expect(b.transport.closed?.code).toBe(4401);
    expect(proc.killCount).toBe(1);
    expect(getSession(sessionId)).toBeUndefined();
  });

  test('a session-authenticated resume rebinds the session to the live sid', async () => {
    const env = makeEnv();
    const { client, sessionId, proc } = await openSession(
      env,
      {},
      { uid: 'u1', tokenId: null, session: ref('old') }
    );
    client.inbound.onClose();
    const b = connect(env, { uid: 'u1', tokenId: null, session: ref('fresh') });
    sendResume(b, sessionId);
    await flush();
    expect(b.transport.json<ExecReady>(EcKind.READY)[0]).toMatchObject({ resumed: true });
    expect(getSession(sessionId)?.sessionRef).toEqual(ref('fresh'));
    closeExecSessionsForSid('old');
    expect(proc.killCount).toBe(0);
    closeExecSessionsForSid('fresh');
    expect(proc.killCount).toBe(1);
    expect(b.transport.closed?.code).toBe(4401);
  });

  test('a rejected resume does not rebind the session', async () => {
    const env = makeEnv();
    const { client, sessionId } = await openSession(
      env,
      {},
      { uid: 'u1', tokenId: null, session: ref('old') }
    );
    client.inbound.onClose();
    const b = connect(env, { uid: 'u1', tokenId: null, session: ref('fresh') });
    b.send(EcKind.HELLO, { v: 1, op: 'resume', sessionId, out: 999_999 });
    await flush();
    expect(errorCode(b)).toBe('resume_gap');
    expect(getSession(sessionId)?.sessionRef).toEqual(ref('old'));
  });
});
