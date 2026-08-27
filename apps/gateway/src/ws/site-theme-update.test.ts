import { beforeAll, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import { WebSocketServer } from './index';
import { createBorshTestWs, setupConnectionEntry } from './test-helpers';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

function createBorshWs() {
  return createBorshTestWs({ session: true });
}

// theme 更新现在还伴随 KIND_SETTINGS_UPDATE 通用事件，取最后一帧 SITE_THEME_UPDATE 解码
function lastSiteThemeUpdateS2C(sent: Uint8Array[]) {
  const frames = sent
    .map((message) => wsBorsh.decodeEnvelope(message))
    .filter((envelope) => envelope.kind === wsBorsh.KIND_SITE_THEME_UPDATE);
  expect(frames.length).toBeGreaterThan(0);
  return wsBorsh.decodePayload(
    wsBorsh.schema.SiteThemeUpdateS2CSchema,
    frames[frames.length - 1].payload
  );
}

describe('WebSocketServer site theme update', () => {
  test('broadcasts S2C to all connected clients including sender', () => {
    const server = new WebSocketServer() as any;
    const ws1 = createBorshWs();
    const ws2 = createBorshWs();

    server.connectedClients = new Set([ws1, ws2]);

    server.handleSiteThemeUpdate(ws1, { theme: wsBorsh.SITE_THEME_LIGHT });

    expect(ws1.sent.length).toBeGreaterThanOrEqual(1);
    expect(ws2.sent.length).toBeGreaterThanOrEqual(1);

    const decoded1 = lastSiteThemeUpdateS2C(ws1.sent);
    const decoded2 = lastSiteThemeUpdateS2C(ws2.sent);
    expect(decoded1.theme).toBe(wsBorsh.SITE_THEME_LIGHT);
    expect(decoded2.theme).toBe(wsBorsh.SITE_THEME_LIGHT);
    expect(typeof decoded1.serverTimestamp).toBe('bigint');
    expect(decoded1.serverTimestamp).toBe(decoded2.serverTimestamp);
  });

  test('rejects invalid theme value', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    server.connectedClients = new Set([ws]);
    const sendErrorSpy: Array<{ code: number; msg: string }> = [];
    server.sendError = (
      _w: unknown,
      _seq: number | null,
      code: number,
      msg: string,
      _retryable: boolean
    ) => {
      sendErrorSpy.push({ code, msg });
    };

    server.handleSiteThemeUpdate(ws, { theme: 42 });
    expect(sendErrorSpy.length).toBe(1);
    expect(sendErrorSpy[0].code).toBe(wsBorsh.ERROR_PAYLOAD_DECODE_FAILED);
    expect(ws.sent.length).toBe(0);
  });

  test('writes theme to SiteSettings DB', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    server.connectedClients = new Set([ws]);

    updateSiteSettings({ theme: 'dark' });
    server.handleSiteThemeUpdate(ws, { theme: wsBorsh.SITE_THEME_LIGHT });

    expect(getSiteSettings().theme).toBe('light');
  });

  test('last-writer-wins: two clients send concurrently, last processed wins', () => {
    const server = new WebSocketServer() as any;
    const ws1 = createBorshWs();
    const ws2 = createBorshWs();
    server.connectedClients = new Set([ws1, ws2]);

    updateSiteSettings({ theme: 'dark' });

    server.handleSiteThemeUpdate(ws1, { theme: wsBorsh.SITE_THEME_LIGHT });
    const ts1 = lastSiteThemeUpdateS2C(ws1.sent).serverTimestamp;

    server.handleSiteThemeUpdate(ws2, { theme: wsBorsh.SITE_THEME_DARK });
    const ts2 = lastSiteThemeUpdateS2C(ws2.sent).serverTimestamp;

    expect(ts2).toBeGreaterThan(ts1);
    expect(getSiteSettings().theme).toBe('dark');
  });

  test('serverTimestamp strictly increasing across consecutive updates', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    server.connectedClients = new Set([ws]);

    server.handleSiteThemeUpdate(ws, { theme: wsBorsh.SITE_THEME_LIGHT });
    const ts1 = lastSiteThemeUpdateS2C(ws.sent).serverTimestamp;

    server.handleSiteThemeUpdate(ws, { theme: wsBorsh.SITE_THEME_DARK });
    const ts2 = lastSiteThemeUpdateS2C(ws.sent).serverTimestamp;

    expect(ts2).toBeGreaterThan(ts1);
  });

  test('triggers window-style update for all connected devices', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    server.connectedClients = new Set([ws]);

    const setWindowStyleCalls: string[] = [];
    setupConnectionEntry(server, {
      deviceId: 'device-a',
      ws,
      runtime: {
        setWindowStyle(style: string) {
          setWindowStyleCalls.push(style);
        },
      },
    });
    setupConnectionEntry(server, {
      deviceId: 'device-b',
      ws,
      runtime: {
        setWindowStyle(style: string) {
          setWindowStyleCalls.push(style);
        },
      },
    });

    server.handleSiteThemeUpdate(ws, { theme: wsBorsh.SITE_THEME_LIGHT });

    expect(setWindowStyleCalls.length).toBe(2);
    for (const style of setWindowStyleCalls) {
      expect(style).toContain('fg=');
      expect(style).toContain('bg=');
    }
  });
});
