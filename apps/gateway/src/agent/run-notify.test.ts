import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { EventType, WebhookEvent } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDevice, ensureSiteSettingsInitialized } from '../db';
import { createAgentSession, ensureAgentSettingsInitialized } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { notifyAgentEvent, setRemoteNameLookup } from './run-notify';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  ensureAgentSettingsInitialized();
  const now = new Date().toISOString();
  createDevice({
    id: 'run-notify-local-device',
    name: 'local-box',
    type: 'local',
    session: 'tmex-test',
    authMode: 'agent',
    port: 22,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(() => {
  setRemoteNameLookup(null);
});

describe('notifyAgentEvent', () => {
  test('local session uses the device row and a local pane URL shape', async () => {
    const session = createAgentSession({
      title: 'Local',
      deviceId: 'run-notify-local-device',
      paneId: '%1',
      modelId: 'mock',
    });
    const calls: Array<{
      eventType: EventType;
      event: Omit<WebhookEvent, 'eventType' | 'timestamp'>;
    }> = [];
    await notifyAgentEvent({
      notify: async (eventType, event) => {
        calls.push({ eventType, event });
      },
      session,
      eventType: 'agent_turn_finished',
      payload: { message: 'done' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event.device.name).toBe('local-box');
    expect(calls[0]?.event.payload?.nodeId).toBeUndefined();
  });

  test('remote session falls back to stored node/device names and /n/<nodeId> payload', async () => {
    const nodeId = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';
    setRemoteNameLookup({
      nodeName: (id) => (id === nodeId ? 'home-mac' : null),
      deviceName: (id, deviceId) => (id === nodeId && deviceId === 'remote-dev' ? 'studio' : null),
    });
    const session = createAgentSession({
      title: 'Remote',
      nodeId,
      deviceId: 'remote-dev',
      paneId: '%4',
      modelId: 'mock',
      originPaneTitle: 'vim',
      originProcessName: 'nvim',
    });
    const calls: Array<{
      eventType: EventType;
      event: Omit<WebhookEvent, 'eventType' | 'timestamp'>;
    }> = [];
    await notifyAgentEvent({
      notify: async (eventType, event) => {
        calls.push({ eventType, event });
      },
      session,
      eventType: 'agent_error',
      payload: { message: 'boom' },
    });
    expect(calls).toHaveLength(1);
    const event = calls[0]?.event;
    expect(event?.device.id).toBe('remote-dev');
    expect(event?.device.name).toBe('studio (home-mac)');
    expect(event?.payload?.nodeId).toBe(nodeId);
    expect(event?.payload?.nodeName).toBe('home-mac');
    expect(event?.tmux?.paneTitle).toBe('vim');
    expect(event?.tmux?.paneCurrentCommand).toBe('nvim');
  });
});
