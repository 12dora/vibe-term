import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  LOGIN_RECORD_CLIENT_HEADER,
  LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER,
  LOGIN_RECORD_RETENTION_DEFAULT,
} from '@vibeterm/shared';
import { standardLoginPolicy } from '@vibeterm/shared/auth';
import { gatewayKv } from '../db/schema';
import { logAuthLoginSuccessIfOk } from '../mesh/auth-audit-log';
import { createLoginFailureSink, loginRequestContext } from '../mesh/auth-key-log-login';
import { LoginPolicyLimiter } from '../mesh/auth-login-limiter';
import { respondToLoginLimit } from '../mesh/auth-login-policy-http';
import { AuthRoutes } from '../mesh/auth-routes';
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh/mesh-deps';
import { recordEntryLogin429 } from './login-records-forward';
import {
  CREDENTIAL_FAILURE_ROWS_PER_MINUTE,
  bindLoginRecorderEnv,
  recordAuthLoginFailure,
  recordAuthLoginSuccess,
  resetLimiterRowThrottle,
  setLimiterRowClock,
} from './login-records-hooks';
import {
  loginRecordIp,
  loginRecordKind,
  readLoginClient,
  readLoginUserAgent,
} from './login-records-meta';
import {
  LoginRecordService,
  LoginRecordSettingsError,
  bindLoginRecordService,
  peekLoginRecordService,
} from './login-records-service';
import {
  LOGIN_RECORD_RETENTION_KV_KEY,
  LoginRecordStore,
  type NewLoginRecord,
} from './login-records-store';
import { createMigratedAuthDb } from './test-db';
import type { AuthDb } from './types';

const DAY_MS = 86_400_000;

describe('login records', () => {
  let db: AuthDb;
  let close: () => void;
  let store: LoginRecordStore;
  let service: LoginRecordService;

  beforeEach(() => {
    const opened = createMigratedAuthDb();
    db = opened.db;
    close = opened.close;
    store = new LoginRecordStore(db, { rowCap: 3 });
    service = new LoginRecordService(store);
    bindLoginRecordService(service);
    bindLoginRecorderEnv({
      nodeId: 'node-a',
      lookupUser: (uid) => (uid === 'user-1' ? { id: 'user-1', username: 'ada' } : null),
    });
  });

  afterEach(() => {
    service.stop();
    bindLoginRecordService(null);
    bindLoginRecorderEnv(null);
    resetLimiterRowThrottle();
    close();
  });

  test('migration creates login_records', () => {
    expect(service.list({ outcome: 'failed', kind: 'all', limit: 1 }).records).toEqual([]);
  });

  test('lists newest first and pages with before', () => {
    service.record(sample({ outcome: 'success', code: null, at: 10 }));
    service.record(sample({ outcome: 'success', code: null, at: 30 }));
    service.record(sample({ outcome: 'success', code: null, at: 20 }));
    const page = service.list({ outcome: 'success', kind: 'interactive', limit: 2 });
    expect(page.records.map((row) => row.at)).toEqual([30, 20]);
    expect(page.nextBefore).toEqual({ at: 20, id: page.records[1]?.id });
    const rest = service.list({
      outcome: 'success',
      kind: 'all',
      limit: 2,
      ...(page.nextBefore ? { before: page.nextBefore } : {}),
    });
    expect(rest.records.map((row) => row.at)).toEqual([10]);
    expect(rest.nextBefore).toBeNull();
    expect(page.records[0]?.code).toBeNull();
  });

  test('kind filter applies to success only', () => {
    service.record(sample({ outcome: 'success', code: null, kind: 'background', at: 2 }));
    service.record(sample({ outcome: 'success', code: null, kind: 'interactive', at: 1 }));
    service.record(sample({ outcome: 'failed', kind: 'background', at: 3 }));
    const success = service.list({ outcome: 'success', kind: 'interactive', limit: 10 });
    expect(success.records.map((row) => row.kind)).toEqual(['interactive']);
    const all = service.list({ outcome: 'success', kind: 'all', limit: 10 });
    expect(all.records).toHaveLength(2);
    const failed = service.list({ outcome: 'failed', kind: 'interactive', limit: 10 });
    expect(failed.records.map((row) => row.kind)).toEqual(['background']);
  });

  test('caps each outcome separately', () => {
    for (let at = 1; at <= 4; at += 1) service.record(sample({ at, code: 'INVALID_CREDENTIALS' }));
    service.record(sample({ outcome: 'success', code: null, at: 9 }));
    const failed = service.list({ outcome: 'failed', kind: 'all', limit: 10 });
    expect(failed.records.map((row) => row.at)).toEqual([4, 3, 2]);
    const success = service.list({ outcome: 'success', kind: 'all', limit: 10 });
    expect(success.records).toHaveLength(1);
  });

  test('retention defaults to 90, rejects unknown values, and sweeps by days', () => {
    expect(service.getSettings()).toEqual({ retentionDays: LOGIN_RECORD_RETENTION_DEFAULT });
    expect(() => service.updateSettings({ retentionDays: 14 })).toThrow(LoginRecordSettingsError);
    expect(service.updateSettings({ retentionDays: 30 })).toEqual({ retentionDays: 30 });
    const now = Date.now();
    service.record(sample({ at: now - 8 * DAY_MS }));
    service.record(sample({ at: now - DAY_MS }));
    service.updateSettings({ retentionDays: 7 });
    service.retentionTick();
    expect(service.list({ outcome: 'failed', kind: 'all', limit: 10 }).records).toHaveLength(1);
    service.updateSettings({ retentionDays: 0 });
    service.record(sample({ at: now - 400 * DAY_MS }));
    service.startSweeper();
    expect(service.list({ outcome: 'failed', kind: 'all', limit: 10 }).records).toHaveLength(2);
  });

  test('invalid stored retention falls back to the default', () => {
    db.insert(gatewayKv)
      .values({ key: LOGIN_RECORD_RETENTION_KV_KEY, value: '14', updatedAt: 't' })
      .run();
    expect(service.getSettings().retentionDays).toBe(90);
  });

  test('record swallows store errors', () => {
    store.insert = () => {
      throw new Error('disk');
    };
    expect(() => service.record(sample())).not.toThrow();
  });

  test('reads client, user agent, kind, and trusted peer ip', () => {
    const direct = new Request('http://local/', {
      headers: {
        [LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER]: '203.0.113.9',
        'user-agent': 'x'.repeat(600),
      },
    });
    setMeshRequestContext(direct, { via: MESH_VIA_SELF, clientIp: '198.51.100.8' });
    expect(loginRecordIp(direct)).toBe('198.51.100.8');
    expect(direct.headers.get(LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER)).toBeNull();
    expect(readLoginUserAgent(direct)?.length).toBe(512);
    expect(readLoginClient(direct)).toBe('unknown');

    const peer = new Request('http://local/', {
      headers: {
        [LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER]: '203.0.113.5',
        [LOGIN_RECORD_CLIENT_HEADER]: 'WEB',
      },
    });
    setMeshRequestContext(peer, { via: 'entry-9', clientIp: 'peer:entry-9' });
    expect(loginRecordIp(peer, true)).toBe('203.0.113.5');
    const stale = new Request('http://local/', {
      headers: { [LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER]: '203.0.113.5' },
    });
    setMeshRequestContext(stale, { via: 'entry-9', clientIp: 'peer:entry-9' });
    expect(loginRecordIp(stale)).toBeNull();
    expect(readLoginClient(peer)).toBe('web');
    expect(loginRecordKind('entry-9', 'node-a')).toBe('background');
    expect(loginRecordKind(MESH_VIA_SELF, 'node-a')).toBe('interactive');
    expect(loginRecordKind('node-a', 'node-a')).toBe('interactive');
  });

  test('records credential failures and skips second-factor challenges', () => {
    const req = requestWithIp('198.51.100.8');
    const seen: string[] = [];
    const sink = createLoginFailureSink(
      {
        recordFailure: (uid) => seen.push(uid),
        loginLimited: () => null,
        peekUid: () => 'user-1',
        uidTooLong: () => false,
      },
      loginRequestContext(req)
    );
    sink.fail('TOTP_REQUIRED');
    sink.fail('PASSKEY_REQUIRED');
    expect(seen).toEqual([]);
    expect(listed('failed')).toHaveLength(0);
    sink.fail('INVALID_CREDENTIALS', 401, 'UNKNOWN_USER');
    expect(seen).toEqual(['']);
    const row = listed('failed')[0];
    expect(row?.code).toBe('INVALID_CREDENTIALS');
    expect(row?.ip).toBe('198.51.100.8');
    expect(row?.kind).toBe('interactive');
    expect(row?.username).toBeNull();
  });

  test('records limiter rejections without dropping the hook', () => {
    const policy = { ...standardLoginPolicy(), exemptLocal: false, ipFailThreshold: 1 };
    const limiter = new LoginPolicyLimiter(
      () => 1_000,
      () => policy
    );
    const req = requestWithIp('198.51.100.9');
    const rejected: string[] = [];
    const input = {
      limiter,
      policy,
      req,
      uidHint: 'user-1',
      ip: '198.51.100.9',
      method: 'root' as const,
      peer: false,
      onReject: (info: { code: string }) => rejected.push(info.code),
    };
    limiter.recordFailure({ ip: input.ip, uid: input.uidHint, method: 'root', exempt: false });
    const res = respondToLoginLimit(input);
    expect(res?.status).toBe(429);
    expect(rejected).toEqual(['RATE_LIMITED']);
    const row = listed('failed')[0];
    expect(row?.code).toBe('RATE_LIMITED');
    expect(row?.uid).toBe('user-1');
    expect(row?.username).toBe('ada');
    expect(row?.method).toBe('root');
  });

  test('records a successful login and ignores other statuses', () => {
    const req = requestWithIp('198.51.100.4', { [LOGIN_RECORD_CLIENT_HEADER]: 'cli' });
    logAuthLoginSuccessIfOk(new Response(null, { status: 401 }), successFields(req));
    expect(listed('success')).toHaveLength(0);
    logAuthLoginSuccessIfOk(new Response(null, { status: 200 }), successFields(req));
    const row = listed('success')[0];
    expect(row?.client).toBe('cli');
    expect(row?.kind).toBe('interactive');
    expect(row?.viaNodeId).toBe('node-a');
    expect(row?.ip).toBe('198.51.100.4');
    expect(row?.username).toBe('ada');
    expect(row?.second).toBe('none');
    expect(row?.code).toBeNull();
  });

  test('records an entry-side forwarded login 429 and leaves the body readable', async () => {
    const req = new Request('http://local/api/auth/login', {
      headers: { [LOGIN_RECORD_CLIENT_HEADER]: 'cli', 'user-agent': 'curl' },
    });
    const response = jsonResponse(429, { code: 'PASSWORD_LOGIN_PAUSED' });
    await recordEntryLogin429('entry', req, 'target', {
      response,
      uidHint: 'user-1',
      ip: '198.51.100.4',
    });
    expect(await response.json()).toEqual({ code: 'PASSWORD_LOGIN_PAUSED' });
    const row = listed('failed')[0];
    expect(row?.kind).toBe('interactive');
    expect(row?.viaNodeId).toBe('entry');
    expect(row?.targetNodeId).toBe('target');
    expect(row?.code).toBe('PASSWORD_LOGIN_PAUSED');
    expect(row?.ip).toBe('198.51.100.4');
    expect(row?.client).toBe('cli');
    await recordEntryLogin429('entry', req, 'target', {
      response: jsonResponse(429, { code: 'SHARE_LOGIN_LOCKED' }),
      uidHint: '',
      ip: '198.51.100.4',
    });
    await recordEntryLogin429('entry', req, 'target', {
      response: jsonResponse(401, { code: 'INVALID_CREDENTIALS' }),
      uidHint: 'user-1',
      ip: '198.51.100.4',
    });
    expect(listed('failed')).toHaveLength(1);
    await recordEntryLogin429('entry', req, 'target', {
      response: jsonResponse(429, { code: 'PASSWORD_LOGIN_PAUSED' }),
      uidHint: 'user-1',
      ip: '198.51.100.4',
    });
    expect(listed('failed')).toHaveLength(1);
  });

  test('pages rows that share a millisecond with an (at, id) cursor', () => {
    service.record(sample({ outcome: 'success', code: null, at: 50 }));
    service.record(sample({ outcome: 'success', code: null, at: 50 }));
    const first = service.list({ outcome: 'success', kind: 'all', limit: 1 });
    expect(first.records).toHaveLength(1);
    expect(first.nextBefore).toEqual({ at: 50, id: first.records[0]?.id });
    const second = service.list({
      outcome: 'success',
      kind: 'all',
      limit: 1,
      ...(first.nextBefore ? { before: first.nextBefore } : {}),
    });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.id).not.toBe(first.records[0]?.id);
  });

  test('trusts entry client ip only when every known peer version is 2.10.0', () => {
    bindLoginRecorderEnv({
      nodeId: 'node-a',
      lookupUser: () => null,
      peerVersion: (id) => (id === 'new-peer' ? '2.10.0' : '2.9.1'),
    });
    const headers = { [LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER]: '203.0.113.5' };
    const oldPeer = new Request('http://local/api/auth/login', { headers });
    setMeshRequestContext(oldPeer, { via: 'old-peer', clientIp: 'peer:old-peer' });
    const fresh = new Request('http://local/api/auth/login', { headers });
    setMeshRequestContext(fresh, { via: 'new-peer', clientIp: 'peer:new-peer' });
    recordAuthLoginFailure({
      uid: 'ghost',
      code: 'INVALID_CREDENTIALS',
      req: oldPeer,
      method: 'root',
    });
    recordAuthLoginFailure({
      uid: 'ghost',
      code: 'INVALID_CREDENTIALS',
      req: fresh,
      method: 'root',
    });
    const rows = listed('failed');
    expect(rows.find((row) => row.viaNodeId === 'old-peer')?.ip).toBeNull();
    expect(rows.find((row) => row.viaNodeId === 'new-peer')?.ip).toBe('203.0.113.5');
  });

  test('throttles credential failure rows per limiter key and uid', () => {
    let now = 1_700_000_000_000;
    setLimiterRowClock(() => now);
    let writes = 0;
    const orig = service.record.bind(service);
    service.record = (row) => {
      writes += 1;
      orig(row);
    };
    const fail = (uid: string, code: string, xff?: string) => {
      const headers: Record<string, string> = {};
      if (xff) headers['x-forwarded-for'] = xff;
      const req = new Request('http://local/api/auth/login', { headers });
      setMeshRequestContext(req, {
        via: MESH_VIA_SELF,
        clientIp: xff ? '127.0.0.1' : '203.0.113.8',
      });
      recordAuthLoginFailure({ uid, code, req, method: 'root' });
    };
    for (let n = 0; n < CREDENTIAL_FAILURE_ROWS_PER_MINUTE; n += 1) {
      fail('ghost', 'INVALID_CREDENTIALS');
    }
    fail('ghost', 'MALFORMED');
    expect(writes).toBe(CREDENTIAL_FAILURE_ROWS_PER_MINUTE);
    fail('other', 'INVALID_CREDENTIALS');
    expect(writes).toBe(CREDENTIAL_FAILURE_ROWS_PER_MINUTE + 1);
    for (let n = 0; n < CREDENTIAL_FAILURE_ROWS_PER_MINUTE; n += 1) {
      fail('ghost', 'INVALID_CREDENTIALS', '198.51.100.1');
    }
    fail('ghost', 'INVALID_CREDENTIALS', '198.51.100.1');
    expect(writes).toBe(CREDENTIAL_FAILURE_ROWS_PER_MINUTE * 2 + 1);
    for (let n = 0; n < CREDENTIAL_FAILURE_ROWS_PER_MINUTE; n += 1) {
      fail('ghost', 'INVALID_CREDENTIALS', '198.51.100.2');
    }
    expect(writes).toBe(CREDENTIAL_FAILURE_ROWS_PER_MINUTE * 3 + 1);
    now += 60_000;
    fail('ghost', 'INVALID_CREDENTIALS');
    expect(writes).toBe(CREDENTIAL_FAILURE_ROWS_PER_MINUTE * 3 + 2);
  });

  test('does not throttle success rows', () => {
    let writes = 0;
    const orig = service.record.bind(service);
    service.record = (row) => {
      writes += 1;
      orig(row);
    };
    const req = requestWithIp('203.0.113.8');
    for (let n = 0; n < CREDENTIAL_FAILURE_ROWS_PER_MINUTE + 2; n += 1) {
      recordAuthLoginSuccess({
        uid: 'user-1',
        via: MESH_VIA_SELF,
        method: 'root',
        second: 'none',
        origin: 'http://local',
        req,
      });
    }
    expect(writes).toBe(CREDENTIAL_FAILURE_ROWS_PER_MINUTE + 2);
  });

  test('login record routes require a session and honor list, clear, and settings', async () => {
    const routes = new AuthRoutes(authDeps({ node: true, relay: false }));
    const anon = await routes.handle(
      new Request('http://local/api/auth/login-records?outcome=failed')
    );
    expect(anon?.status).toBe(401);
    service.record(sample({ at: 5 }));
    const authed = await routes.handle(
      authedRequest('GET', '/api/auth/login-records?outcome=failed')
    );
    expect(authed?.status).toBe(200);
    const page = (await authed?.json()) as { records: { at: number }[] };
    expect(page.records.map((row) => row.at)).toEqual([5]);
    const bad = await routes.handle(authedRequest('GET', '/api/auth/login-records?outcome=nope'));
    expect(bad?.status).toBe(400);
    const settings = await routes.handle(authedRequest('GET', '/api/auth/login-records/settings'));
    expect(await settings?.json()).toEqual({ retentionDays: 90 });
    const put = await routes.handle(
      authedRequest('PUT', '/api/auth/login-records/settings', { retentionDays: 180 })
    );
    expect(await put?.json()).toEqual({ retentionDays: 180 });
    const invalid = await routes.handle(
      authedRequest('PUT', '/api/auth/login-records/settings', { retentionDays: 14 })
    );
    expect(invalid?.status).toBe(400);
    const cleared = await routes.handle(authedRequest('DELETE', '/api/auth/login-records'));
    expect(await cleared?.json()).toEqual({ deleted: 1 });
    const open = new AuthRoutes(authDeps({ node: false, relay: false }));
    const bypass = await open.handle(
      new Request('http://local/api/auth/login-records?outcome=failed')
    );
    expect(bypass?.status).toBe(401);
  });
});

function sample(over: Partial<NewLoginRecord> = {}): NewLoginRecord {
  return {
    outcome: 'failed',
    uid: 'ghost',
    username: null,
    method: null,
    second: null,
    client: 'unknown',
    kind: 'interactive',
    viaNodeId: 'node-a',
    targetNodeId: 'node-a',
    ip: null,
    userAgent: null,
    origin: null,
    code: 'INVALID_CREDENTIALS',
    ...over,
  };
}

function listed(outcome: 'success' | 'failed') {
  const bound = peekLoginRecordService();
  if (!bound) throw new Error('login record service is not bound');
  return bound.list({ outcome, kind: 'all', limit: 20 }).records;
}

function requestWithIp(ip: string, headers?: HeadersInit): Request {
  const req = new Request('http://local/api/auth/login', { headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: ip });
  return req;
}

function successFields(req: Request) {
  return {
    uid: 'user-1',
    via: MESH_VIA_SELF,
    method: 'root',
    totpBody: null,
    passkeyBody: null,
    waived: false,
    ip: '',
    origin: 'http://local',
    req,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authedRequest(method: string, path: string, body?: unknown): Request {
  const req = new Request(`http://local${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  setMeshRequestContext(req, { via: 'peer-1', uid: 'user-1', clientIp: 'peer:peer-1' });
  return req;
}

function authDeps(roles: { node: boolean; relay: boolean }) {
  const userStore = {
    getById: (id: string) => (id === 'user-1' ? { id, username: 'ada' } : null),
    getByUsername: () => null,
    listUsers: () => [],
    listCerts: () => [],
    listNodes: () => [],
  };
  return {
    roles,
    nodeId: 'node-a',
    nodePk: new Uint8Array(32),
    userStore,
    keyLogService: {},
    challengeStore: {},
    nodeSessionStore: {},
    publisher: {},
    localAuth: { getEnabled: () => false, setEnabled: () => undefined },
  } as unknown as ConstructorParameters<typeof AuthRoutes>[0];
}
