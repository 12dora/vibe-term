import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import { type RelayCtlMessage, type RelayEnvelope, decodeRelayCtl } from '@tmex/shared/relay';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import { RELAY_TOKEN_HEADER } from './relay-routes';
import { type RelayRuntime, createRelayRuntime } from './relay-runtime';
import { type RelayTenantHandle, createTenant } from './relay-test-tenant';
import type { RelayRuntimeConfig } from './types';

export const RELAY_TEST_PUBLIC_URL = 'https://relay.example';
export const RELAY_TEST_ADMIN_TOKEN = 'relay-test-admin-token';

export type RelayCtlInbox = {
  take(timeoutMs?: number): Promise<RelayCtlMessage>;
  takeOf(type: RelayCtlMessage['t'], timeoutMs?: number): Promise<RelayCtlMessage>;
  drain(): RelayCtlMessage[];
};

export type RelayHarnessOptions = {
  config?: Partial<RelayRuntimeConfig>;
  now?: () => number;
  listDebounceMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
  authTimeoutMs?: number;
  meterFlushIntervalMs?: number;
  minClientVersion?: string;
  isLocalUserAuthenticated?: (req: Request) => boolean | Promise<boolean>;
  clientIp?: (req: Request) => string;
  password?: string;
  authBarrier?: () => Promise<void>;
};

export type RelayHarness = {
  runtime: RelayRuntime;
  db: AuthDb;
  adminToken: string;
  now(): number;
  advance(ms: number): void;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  adminFetch(path: string, init?: RequestInit): Promise<Response>;
  tenantFetch(path: string, token: string, init?: RequestInit): Promise<Response>;
  createTenant(opts?: { password?: string; uid?: string }): Promise<RelayTenantHandle>;
  close(): Promise<void>;
};

const BASE = 'http://relay.local';

/** 中继看不到密文内容，测试里的日志块只要结构合法即可。 */
export function testEnvelope(text: string): RelayEnvelope {
  return {
    v: 1,
    epoch: 1,
    n: encodeBase64url(randomBytes(12)),
    ct: encodeBase64url(new TextEncoder().encode(text)),
  };
}

function upgradeServer(): { upgrade: () => boolean } {
  return { upgrade: () => false };
}

export function relayCtlInbox(link: LinkSession): RelayCtlInbox {
  const queue: RelayCtlMessage[] = [];
  const waiters: Array<(msg: RelayCtlMessage) => void> = [];
  link.ctl.onMessage((bytes) => {
    let msg: RelayCtlMessage;
    try {
      msg = decodeRelayCtl(bytes);
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  const take = (timeoutMs = 1_000): Promise<RelayCtlMessage> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<RelayCtlMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay ctl timeout')), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };
  return {
    take,
    async takeOf(type, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const msg = await take(Math.max(1, deadline - Date.now()));
        if (msg.t === type) return msg;
        if (Date.now() >= deadline) throw new Error(`relay ctl timeout waiting for ${type}`);
      }
    },
    drain() {
      const out = queue.slice();
      queue.length = 0;
      return out;
    },
  };
}

export async function bootRelayHarness(opts: RelayHarnessOptions = {}): Promise<RelayHarness> {
  const { db, close } = createMigratedAuthDb();
  let clock = 1_700_000_000_000;
  const now = opts.now ?? (() => clock);
  const runtime = await createRelayRuntime({
    db,
    now,
    startedAt: now(),
    version: '1.1.23',
    config: {
      publicUrl: RELAY_TEST_PUBLIC_URL,
      stun: ['stun:stun.example:3478'],
      turn: null,
      adminToken: RELAY_TEST_ADMIN_TOKEN,
      ...opts.config,
    },
    listDebounceMs: opts.listDebounceMs ?? 0,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 0,
    heartbeatMissLimit: opts.heartbeatMissLimit,
    authTimeoutMs: opts.authTimeoutMs ?? 60_000,
    meterFlushIntervalMs: opts.meterFlushIntervalMs ?? 0,
    minClientVersion: opts.minClientVersion,
    isLocalUserAuthenticated: opts.isLocalUserAuthenticated,
    clientIp: opts.clientIp ?? (() => '127.0.0.1'),
    authBarrier: opts.authBarrier,
    sleep: () => Promise.resolve(),
    log: () => {},
  });
  const harness: RelayHarness = {
    runtime,
    db,
    adminToken: RELAY_TEST_ADMIN_TOKEN,
    now: () => now(),
    advance(ms) {
      clock += ms;
    },
    async fetch(path, init) {
      const res = await runtime.handleRequest(new Request(`${BASE}${path}`, init), upgradeServer());
      return res ?? new Response(null, { status: 204 });
    },
    adminFetch(path, init) {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${RELAY_TEST_ADMIN_TOKEN}`);
      if (init?.body && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return harness.fetch(path, { ...init, headers });
    },
    tenantFetch(path, token, init) {
      const headers = new Headers(init?.headers);
      headers.set(RELAY_TOKEN_HEADER, token);
      if (init?.body && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return harness.fetch(path, { ...init, headers });
    },
    createTenant(tenantOpts) {
      return createTenant(harness, now, tenantOpts);
    },
    async close() {
      await runtime.stop();
      close();
    },
  };
  if (opts.password) {
    const res = await harness.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: opts.password, mode: 'keep' }),
    });
    if (!res.ok) throw new Error(`failed to set relay password: ${res.status}`);
  }
  return harness;
}

/** 用给定根钥直接打 `/api/relay/enroll`（重复 enroll / 旧根 enroll 的用例都走它）。 */
export { enrollRelayRoot } from './relay-test-tenant';
export type {
  RelayMemberFixture,
  RelayNodeClient,
  RelayNodeFixture,
  RelayRotateFixture,
  RelayTenantHandle,
} from './relay-test-tenant';
