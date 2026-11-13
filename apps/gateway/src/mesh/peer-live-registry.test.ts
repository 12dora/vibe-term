import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import { PeerLiveRegistry } from './peer-live-registry';
import type { PeerLiveRegistryDeps } from './peer-live-types';
import type { PeerManagerState } from './peer-manager-state';

describe('PeerLiveRegistry', () => {
  test('track 拒绝把本机装成 live peer', () => {
    const closed: string[] = [];
    const session = {
      close(reason?: string) {
        closed.push(reason ?? '');
      },
    } as LinkSession;
    const nodeId = 'aa'.repeat(16);
    const state = {
      identity: { nodeId },
      generation: 1,
      stopped: false,
      live: new Map(),
    } as unknown as PeerManagerState;
    const registry = new PeerLiveRegistry(state, {
      idleMs: 1_000,
      maxConcurrentStreams: 1,
      dispatchHttp: () => undefined,
      onGatewaySession: null,
      onGatewaySessionClose: null,
      onLinkInfo: null,
      deps: {} as PeerLiveRegistryDeps,
    });
    expect(registry.track(session, nodeId, 'ws-secure', 'self', 1)).toBeNull();
    expect(closed).toEqual(['self']);
    expect(state.live.size).toBe(0);
  });
});
