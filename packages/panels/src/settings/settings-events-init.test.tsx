import { beforeAll, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createAppRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type {
  ConnectionState,
  GatewayTransport,
  GatewayTransportCommand,
  GatewayTransportEvent,
} from '@tmex/ws-client';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SETTINGS_NAMESPACE_QUERY_KEYS,
  SettingsEventsInit,
  queryKeysForNamespace,
  subscribeSettingsInvalidation,
} from './settings-events-init';

const GATEWAY_BROADCASTER_PATH = new URL(
  '../../../../apps/gateway/src/settings/broadcaster.ts',
  import.meta.url
);

async function readGatewayNamespaces(): Promise<string[]> {
  const source = await Bun.file(GATEWAY_BROADCASTER_PATH).text();
  const union = /export type SettingsNamespace =([^;]+);/.exec(source);
  if (!union) {
    throw new Error('SettingsNamespace union not found in gateway broadcaster');
  }
  return [...union[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

type TransportEventHandler = Parameters<GatewayTransport['onEvent']>[0];

class FakeTransport implements GatewayTransport {
  readonly kind = 'websocket' as const;
  readonly sourceRoute = 'gateway' as const;
  readonly capabilities = {
    sequencedTerminal: true,
    atomicScreen: true,
    cursorHistory: true,
    serverSelection: true,
  };
  readonly hasConnectedOnce = true;
  readonly latencyMs = null;
  readonly latencyRawMs = null;
  readonly serverCapabilities: readonly string[] = [];
  readonly handlers = new Set<TransportEventHandler>();

  connect(): void {}
  disconnect(): void {}
  dispose(): void {}
  getState(): ConnectionState {
    return 'READY';
  }
  isReady(): boolean {
    return true;
  }
  send(_command: GatewayTransportCommand): boolean {
    return true;
  }
  onEvent(handler: TransportEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  emit(event: GatewayTransportEvent): void {
    for (const handler of [...this.handlers]) {
      handler(event);
    }
  }
}

function recordInvalidations(queryClient: QueryClient): SettingsQueryKeyLog {
  const log: SettingsQueryKeyLog = [];
  queryClient.invalidateQueries = async (filters?: { queryKey?: readonly unknown[] }) => {
    log.push(filters?.queryKey ?? []);
  };
  return log;
}

type SettingsQueryKeyLog = Array<readonly unknown[]>;

beforeAll(() => {
  installWindowStorage();
});

describe('SETTINGS_NAMESPACE_QUERY_KEYS', () => {
  test('covers every gateway settings namespace', async () => {
    const namespaces = await readGatewayNamespaces();

    expect(namespaces.length).toBeGreaterThan(0);
    expect([...SETTINGS_NAMESPACE_QUERY_KEYS.keys()].sort()).toEqual([...namespaces].sort());
  });

  test('only theme and tree-order are explicit no-ops', async () => {
    const namespaces = await readGatewayNamespaces();
    const noop = namespaces.filter((ns) => queryKeysForNamespace(ns).length === 0);

    expect(noop.sort()).toEqual(['theme', 'tree-order']);
  });

  test('maps known namespaces to their caches', () => {
    expect(queryKeysForNamespace('llm')).toEqual([['llm-providers'], ['llm-settings']]);
    expect(queryKeysForNamespace('file-roots')).toEqual([
      ['files'],
      ['terminal-file-links', 'roots'],
    ]);
    expect(queryKeysForNamespace('devices')).toEqual([['devices']]);
    expect(queryKeysForNamespace('terminal-shortcuts')).toEqual([['terminal-shortcuts']]);
  });

  test('returns no keys for unknown or prototype-shaped namespaces', () => {
    expect(queryKeysForNamespace('nope')).toEqual([]);
    expect(queryKeysForNamespace('__proto__')).toEqual([]);
    expect(queryKeysForNamespace('constructor')).toEqual([]);
  });
});

describe('subscribeSettingsInvalidation', () => {
  test('invalidates every mapped key for the namespace', () => {
    const transport = new FakeTransport();
    const queryClient = new QueryClient();
    const log = recordInvalidations(queryClient);

    subscribeSettingsInvalidation(transport, queryClient);
    transport.emit({ type: 'settings-update', namespace: 'telegram' });

    expect(log).toEqual([['telegram-bots'], ['telegram-bot-chats']]);
  });

  test('ignores unknown namespaces and unrelated transport events', () => {
    const transport = new FakeTransport();
    const queryClient = new QueryClient();
    const log = recordInvalidations(queryClient);

    subscribeSettingsInvalidation(transport, queryClient);
    transport.emit({ type: 'settings-update', namespace: 'unknown-namespace' });
    transport.emit({ type: 'settings-update', namespace: 'theme' });
    transport.emit({ type: 'device-connected', deviceId: 'd1' });

    expect(log).toEqual([]);
  });

  test('marks the cached query invalidated', () => {
    const transport = new FakeTransport();
    const queryClient = new QueryClient();
    queryClient.setQueryData(['webhooks'], []);

    subscribeSettingsInvalidation(transport, queryClient);
    transport.emit({ type: 'settings-update', namespace: 'webhooks' });

    expect(queryClient.getQueryState(['webhooks'])?.isInvalidated).toBe(true);
  });

  test('unsubscribing stops further invalidation', () => {
    const transport = new FakeTransport();
    const queryClient = new QueryClient();
    const log = recordInvalidations(queryClient);

    const unsubscribe = subscribeSettingsInvalidation(transport, queryClient);
    unsubscribe();
    transport.emit({ type: 'settings-update', namespace: 'weixin' });

    expect(transport.handlers.size).toBe(0);
    expect(log).toEqual([]);
  });
});

describe('SettingsEventsInit', () => {
  test('renders nothing and registers no query of its own', () => {
    const transport = new FakeTransport();
    const runtime = createAppRuntime({ transport });
    const queryClient = new QueryClient();

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider runtime={runtime}>
          <SettingsEventsInit />
        </RuntimeProvider>
      </QueryClientProvider>
    );

    expect(html).toBe('');
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    runtime.dispose();
  });
});
