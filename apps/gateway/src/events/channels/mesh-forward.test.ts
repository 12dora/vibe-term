import { afterEach, describe, expect, test } from 'bun:test';
import type {
  EventType,
  MeshNotificationForwardRequest,
  MeshNotificationSink,
  WebhookEvent,
} from '@vibeterm/shared';
import { setMeshNotificationBridge } from '../../mesh/notification-mesh-bridge';
import { MeshForwardChannel, buildForwardRequest, isLocallyOriginatedEvent } from './mesh-forward';

function event(payload?: Record<string, unknown>): WebhookEvent {
  return {
    eventType: 'terminal_bell',
    timestamp: '2026-09-06T00:00:00.000Z',
    site: { name: 'site', url: 'https://a.example' },
    device: { id: 'dev-1', name: 'dev', type: 'local' },
    tmux: { paneId: '%1' },
    ...(payload ? { payload } : {}),
  };
}

function installBridge(sinks: MeshNotificationSink[]) {
  const delivered: Array<{ sink: string; body: MeshNotificationForwardRequest }> = [];
  setMeshNotificationBridge({
    selfNodeId: () => 'node-a',
    selfName: () => 'A 机',
    selfSinkEnabled: () => false,
    sinkAuthorized: (nodeId) => sinks.some((row) => row.nodeId === nodeId && !row.self),
    listSinks: () => sinks,
    deliver: async (sink, body) => {
      delivered.push({ sink, body });
      return new Response('{}', { status: 200 });
    },
  });
  return delivered;
}

function sink(nodeId: string, self = false): MeshNotificationSink {
  return { nodeId, name: nodeId, self, online: true };
}

afterEach(() => {
  setMeshNotificationBridge(null);
});

describe('isLocallyOriginatedEvent', () => {
  test('没有 payload.nodeId 才是本机事件', () => {
    expect(isLocallyOriginatedEvent(event())).toBe(true);
    expect(isLocallyOriginatedEvent(event({ nodeId: '  ' }))).toBe(true);
    expect(isLocallyOriginatedEvent(event({ nodeId: 'node-b' }))).toBe(false);
  });
});

describe('buildForwardRequest', () => {
  test('剥掉 eventType / timestamp，附上来源', () => {
    const body = buildForwardRequest('terminal_bell' as EventType, event({ source: 'osc9' }), {
      nodeId: 'node-a',
      nodeName: 'A 机',
    });
    expect(body.eventType).toBe('terminal_bell');
    expect(body.origin).toEqual({ nodeId: 'node-a', nodeName: 'A 机' });
    expect(Object.keys(body.event).sort()).toEqual(['device', 'payload', 'site', 'tmux']);
  });
});

describe('MeshForwardChannel', () => {
  test('没有 mesh 桥时什么都不做', async () => {
    const channel = new MeshForwardChannel();
    await channel.notify('terminal_bell', event());
    expect(channel.stats()).toEqual({ pending: 0, dropped: 0 });
  });

  test('转发给除自己以外的全部汇聚机', async () => {
    const delivered = installBridge([sink('node-a', true), sink('node-b'), sink('node-c')]);
    const channel = new MeshForwardChannel();
    await channel.notify('terminal_bell', event());
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered.map((d) => d.sink).sort()).toEqual(['node-b', 'node-c']);
    expect(delivered[0]?.body.origin).toEqual({ nodeId: 'node-a', nodeName: 'A 机' });
  });

  test('只有本机是汇聚机时不发起任何投递', async () => {
    const delivered = installBridge([sink('node-a', true)]);
    const channel = new MeshForwardChannel();
    await channel.notify('terminal_bell', event());
    await Promise.resolve();
    expect(delivered).toHaveLength(0);
  });

  test('带 payload.nodeId 的远端 agent 事件不转发（发起机已上报，避免重复与成环）', async () => {
    const delivered = installBridge([sink('node-b')]);
    const channel = new MeshForwardChannel();
    await channel.notify('agent_turn_finished', event({ nodeId: 'node-c', nodeName: 'C' }));
    await Promise.resolve();
    expect(delivered).toHaveLength(0);
  });

  test('汇聚机收下的转发件不会被二次转发', async () => {
    const delivered = installBridge([sink('node-c')]);
    const channel = new MeshForwardChannel();
    await channel.notify('terminal_bell', event({ nodeId: 'node-b', nodeName: 'B' }));
    await Promise.resolve();
    expect(delivered).toHaveLength(0);
  });

  test('桥被清空（mesh 停机）时立刻收掉队列与重试', async () => {
    setMeshNotificationBridge({
      selfNodeId: () => 'node-a',
      selfName: () => 'A 机',
      selfSinkEnabled: () => false,
      sinkAuthorized: () => true,
      listSinks: () => [sink('node-b')],
      deliver: async () => new Response('{}', { status: 502 }),
    });
    const channel = new MeshForwardChannel();
    await channel.notify('terminal_bell', event());
    await Promise.resolve();
    await Promise.resolve();
    expect(channel.stats().pending).toBe(1);

    setMeshNotificationBridge(null);
    expect(channel.stats().pending).toBe(0);
    await channel.notify('terminal_bell', event());
    expect(channel.stats().pending).toBe(0);
  });
});
