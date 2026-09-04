import { afterEach, describe, expect, test } from 'bun:test';
import type { UserStore } from '../auth/user-store';
import { RelayUplinkClient } from './relay-uplink-client';
import { type RelayWiring, relayUplinkOverrides } from './relay-wiring';
import { fakeSocketPair, waitUntil } from './test-support';
import type { KeyLogApplier, UplinkStatus } from './types';
import type { UplinkClientOptions } from './uplink-client';

const RELAY_URL = 'https://relay.example';

function stubWiring(): RelayWiring {
  return {
    secrets: {
      uplinkKind: () => 'relay',
      relayRows: () => [{ url: RELAY_URL, priority: 0 }],
    },
  } as unknown as RelayWiring;
}

function baseClientOpts(wsFactory: UplinkClientOptions['wsFactory']): UplinkClientOptions {
  return {
    hubUrl: RELAY_URL,
    identity: { nodeId: 'aa'.repeat(16), edSecretKey: new Uint8Array(64) },
    userId: 'user-1',
    keyLogApplier: {
      async head() {
        return { seq: 0n, hash: new Uint8Array(32) };
      },
      async applyMany() {
        return { applied: 0 };
      },
    } as KeyLogApplier,
    userStore: {} as UserStore,
    statusProvider: (): UplinkStatus => ({
      version: '1',
      tmux: false,
      direct_capable: false,
      inventory: {},
      endpoints: [],
    }),
    wsFactory,
  };
}

const originalFetch = globalThis.fetch;
const envKeys = ['TMEX_ROLES', 'TMEX_RELAY_PUBLIC_URL', 'GATEWAY_PORT'] as const;
const envSaved: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const key of envKeys) envSaved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = envSaved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe('relayUplinkOverrides dial', () => {
  test('把构造时的 RelayDialContext 传给客户端，不读后续 env', async () => {
    saveEnv();
    process.env.TMEX_ROLES = 'node';
    process.env.TMEX_RELAY_PUBLIC_URL = 'https://other.example';
    process.env.GATEWAY_PORT = '1';
    const [ws] = fakeSocketPair();
    const dialed: string[] = [];
    const overrides = relayUplinkOverrides(stubWiring(), {
      nameProvider: () => 'n',
      dial: { roles: { relay: true }, relayPublicUrl: RELAY_URL, gatewayPort: 19111 },
    });
    const client = overrides.createClient(
      baseClientOpts((url) => {
        dialed.push(url);
        queueMicrotask(() => ws.close());
        return ws;
      })
    );
    expect(client).toBeInstanceOf(RelayUplinkClient);
    const ac = new AbortController();
    const connecting = client.attemptConnect(ac.signal);
    await waitUntil(() => dialed.length > 0);
    ac.abort();
    await connecting.catch(() => undefined);
    expect(dialed).toEqual(['ws://127.0.0.1:19111/relay/uplink']);
  });

  test('未传入 dial 时从 env 快照一次，之后改 env 不影响拨号', async () => {
    saveEnv();
    process.env.TMEX_ROLES = 'relay,node';
    process.env.TMEX_RELAY_PUBLIC_URL = RELAY_URL;
    process.env.GATEWAY_PORT = '19993';
    const overrides = relayUplinkOverrides(stubWiring(), { nameProvider: () => 'n' });
    process.env.TMEX_ROLES = 'node';
    process.env.TMEX_RELAY_PUBLIC_URL = 'https://other.example';
    process.env.GATEWAY_PORT = '1';
    const [ws] = fakeSocketPair();
    const dialed: string[] = [];
    const client = overrides.createClient(
      baseClientOpts((url) => {
        dialed.push(url);
        queueMicrotask(() => ws.close());
        return ws;
      })
    );
    const ac = new AbortController();
    const connecting = client.attemptConnect(ac.signal);
    await waitUntil(() => dialed.length > 0);
    ac.abort();
    await connecting.catch(() => undefined);
    expect(dialed).toEqual(['ws://127.0.0.1:19993/relay/uplink']);
  });

  test('健康探测使用同一份 dial 快照', async () => {
    saveEnv();
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const overrides = relayUplinkOverrides(stubWiring(), {
      nameProvider: () => 'n',
      dial: { roles: { relay: true }, relayPublicUrl: RELAY_URL, gatewayPort: 19111 },
    });
    expect(await overrides.probeHealthz(RELAY_URL, null, 1_000)).toBe(true);
    expect(seen).toEqual(['http://127.0.0.1:19111/api/relay/health']);
  });
});

describe('relayUplinkOverrides candidates', () => {
  test('启动时把首选中继排到最前', () => {
    const wiring = {
      secrets: {
        uplinkKind: () => 'relay' as const,
        relayRows: () => [
          { url: 'https://a.example', priority: 0 },
          { url: 'https://b.example', priority: 1 },
          { url: 'https://c.example', priority: 2 },
        ],
        preferredRelayUrl: () => 'https://c.example',
      },
    } as unknown as RelayWiring;
    const overrides = relayUplinkOverrides(wiring, { nameProvider: () => 'n' });
    expect(overrides.candidates().map((row) => row.publicUrl)).toEqual([
      'https://c.example',
      'https://a.example',
      'https://b.example',
    ]);
  });
});
