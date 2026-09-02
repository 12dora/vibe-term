import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { ensureSiteSettingsInitialized, getStoredSiteSettings, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import { handleApiRequest } from './index';
import { setSiteSettingsLinkProvider } from './site-settings-link';

const fakeServer = {} as Server<unknown>;

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

afterEach(() => {
  setSiteSettingsLinkProvider(null);
});

async function call(
  method: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request('http://localhost/api/settings/site', {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleApiRequest(req, fakeServer);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/settings/site mesh link fields', () => {
  test('standalone: stored URL, editable, not linked', async () => {
    const stored = getStoredSiteSettings();
    const { status, json } = await call('GET');
    expect(status).toBe(200);
    const settings = json.settings as Record<string, unknown>;
    expect(json.effectiveSiteUrl).toBe(stored.siteUrl);
    expect(json.siteUrlEditable).toBe(true);
    expect(json.siteNameLinkedToNode).toBe(false);
    expect(json.nodeId).toBeNull();
    expect(settings.siteUrl).toBe(stored.siteUrl);
    expect(settings.effectiveSiteUrl).toBe(stored.siteUrl);
    expect(settings.siteUrlEditable).toBe(true);
    expect(settings.siteNameLinkedToNode).toBe(false);
    expect(settings.nodeId).toBeNull();
  });

  test('mesh hub: overlays siteUrl and marks fields managed', async () => {
    const nodeId = 'ab'.repeat(16);
    setSiteSettingsLinkProvider({
      linked: () => true,
      localNodeId: () => nodeId,
      effectiveSiteUrl: () => 'https://hub.example',
    });
    const { status, json } = await call('GET');
    expect(status).toBe(200);
    const settings = json.settings as Record<string, unknown>;
    expect(json.effectiveSiteUrl).toBe('https://hub.example');
    expect(json.siteUrlEditable).toBe(false);
    expect(json.siteNameLinkedToNode).toBe(true);
    expect(json.nodeId).toBe(nodeId);
    expect(settings.siteUrl).toBe('https://hub.example');
    expect(getStoredSiteSettings().siteUrl).not.toBe('https://hub.example');
  });

  test('mesh node falls back to stored URL when hub URL is unknown', async () => {
    const stored = getStoredSiteSettings();
    setSiteSettingsLinkProvider({
      linked: () => true,
      localNodeId: () => 'cd'.repeat(16),
      effectiveSiteUrl: () => null,
    });
    const { json } = await call('GET');
    expect(json.effectiveSiteUrl).toBe(stored.siteUrl);
    expect((json.settings as Record<string, unknown>).siteUrl).toBe(stored.siteUrl);
    expect(json.siteUrlEditable).toBe(false);
    expect(json.siteNameLinkedToNode).toBe(true);
  });
});

describe('PATCH /api/settings/site mesh managed identity', () => {
  test('rejects a different siteUrl with site_url_managed and does not save other fields', async () => {
    const before = getStoredSiteSettings();
    setSiteSettingsLinkProvider({
      linked: () => true,
      localNodeId: () => 'ab'.repeat(16),
      effectiveSiteUrl: () => 'https://hub.example',
    });
    const { status, json } = await call('PATCH', {
      siteUrl: 'https://other.example',
      language: before.language === 'zh_CN' ? 'en_US' : 'zh_CN',
    });
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'site_url_managed' });
    expect(getStoredSiteSettings().language).toBe(before.language);
    expect(getStoredSiteSettings().siteUrl).toBe(before.siteUrl);
  });

  test('rejects a different siteName with site_name_managed', async () => {
    setSiteSettingsLinkProvider({
      linked: () => true,
      localNodeId: () => 'ab'.repeat(16),
      effectiveSiteUrl: () => 'https://hub.example',
    });
    const { status, json } = await call('PATCH', { siteName: 'not-the-current-name' });
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'site_name_managed' });
  });

  test('unchanged identity values are ignored so a full form resubmit still saves other fields', async () => {
    const before = getStoredSiteSettings();
    const nextBell = !before.enableBellSound;
    setSiteSettingsLinkProvider({
      linked: () => true,
      localNodeId: () => 'ab'.repeat(16),
      effectiveSiteUrl: () => 'https://hub.example/',
    });
    try {
      const { status, json } = await call('PATCH', {
        siteName: ` ${before.siteName} `,
        siteUrl: 'https://hub.example',
        enableBellSound: nextBell,
      });
      expect(status).toBe(200);
      const settings = json.settings as Record<string, unknown>;
      expect(settings.enableBellSound).toBe(nextBell);
      expect(settings.siteUrl).toBe('https://hub.example/');
      expect(json.siteUrlEditable).toBe(false);
      expect(getStoredSiteSettings().siteUrl).toBe(before.siteUrl);
      expect(getStoredSiteSettings().siteName).toBe(before.siteName);
    } finally {
      updateSiteSettings({ enableBellSound: before.enableBellSound });
    }
  });
});
