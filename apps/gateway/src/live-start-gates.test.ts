import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from './db/client';
import { portMaps, telegramBots, tunnelAccess, tunnelConfig } from './db/schema';
import { createTelegramBot } from './db/telegram';
import {
  defaultLiveStartGates,
  guardGate,
  liveServicesEnabled,
  setLiveServicesEnabled,
} from './live-start-gates';
import { PortMapStore } from './portmap/store';
import { TunnelConfigStore } from './tunnel/config-store';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../drizzle') });
});

beforeEach(() => {
  const db = getOrmDb();
  db.delete(portMaps).run();
  db.delete(tunnelConfig).run();
  db.delete(tunnelAccess).run();
  db.delete(telegramBots).run();
});

function seedTelegramBot(id: string, enabled: boolean): void {
  const now = new Date().toISOString();
  createTelegramBot({
    id,
    name: id,
    tokenEnc: 'enc',
    enabled,
    allowAuthRequests: true,
    allowCommands: false,
    lastUpdateId: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('live start gates', () => {
  test('guardGate treats a failing check as configured', () => {
    const gate = guardGate(() => {
      throw new Error('db unavailable');
    });
    expect(gate()).toBe(true);
    expect(guardGate(() => false)()).toBe(false);
  });

  test('tunnel gate opens once any tunnel config row exists', () => {
    expect(defaultLiveStartGates.tunnel()).toBe(false);
    new TunnelConfigStore(getOrmDb()).save({ autoStart: false });
    expect(defaultLiveStartGates.tunnel()).toBe(true);
  });

  test('port map gate follows persisted maps', () => {
    expect(defaultLiveStartGates.portMaps()).toBe(false);
    new PortMapStore(getOrmDb()).insert({
      id: 'gate-map',
      name: 'gate',
      listenHost: '127.0.0.1',
      listenPort: 18081,
      targetNodeId: 'node-b',
      targetHost: '127.0.0.1',
      targetPort: 80,
      paused: false,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(defaultLiveStartGates.portMaps()).toBe(true);
  });

  test('telegram gate ignores disabled bots', () => {
    seedTelegramBot('gate-off', false);
    expect(defaultLiveStartGates.telegram()).toBe(false);
    seedTelegramBot('gate-on', true);
    expect(defaultLiveStartGates.telegram()).toBe(true);
  });

  test('live flag round-trips', () => {
    setLiveServicesEnabled(true);
    expect(liveServicesEnabled()).toBe(true);
    setLiveServicesEnabled(false);
    expect(liveServicesEnabled()).toBe(false);
  });
});
