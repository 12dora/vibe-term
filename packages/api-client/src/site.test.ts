import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { fetchSiteSettings } from './site';

class StubApiClient extends ApiClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  constructor(private responses: Response[]) {
    super('');
  }

  override fetch(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ path, init });
    const next = this.responses.shift();
    if (!next) return Promise.reject(new Error('unexpected request'));
    return Promise.resolve(next);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const stored = {
  siteName: 'tmex',
  siteUrl: 'https://hub.example',
  bellThrottleSeconds: 6,
  notificationThrottleSeconds: 3,
  enableBrowserNotificationToast: true,
  enableNotificationPush: true,
  enableBellPush: true,
  enableBellSound: true,
  sshReconnectMaxRetries: 2,
  sshReconnectDelaySeconds: 10,
  language: 'zh_CN',
  theme: 'dark',
  disabledNotificationChannels: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('fetchSiteSettings', () => {
  test('merges sibling mesh link fields onto the returned settings view', async () => {
    const client = new StubApiClient([
      jsonResponse({
        settings: { ...stored, siteUrl: 'https://hub.example/n/aabb' },
        effectiveSiteUrl: 'https://hub.example/n/aabb',
        siteUrlEditable: false,
        siteNameLinkedToNode: true,
        nodeId: 'aa'.repeat(16),
      }),
    ]);
    const settings = await fetchSiteSettings(client);
    expect(client.calls).toEqual([{ path: '/api/settings/site', init: undefined }]);
    expect(settings.siteUrl).toBe('https://hub.example/n/aabb');
    expect(settings.effectiveSiteUrl).toBe('https://hub.example/n/aabb');
    expect(settings.siteUrlEditable).toBe(false);
    expect(settings.siteNameLinkedToNode).toBe(true);
    expect(settings.nodeId).toBe('aa'.repeat(16));
  });

  test('standalone payload defaults link flags from siblings', async () => {
    const client = new StubApiClient([
      jsonResponse({
        settings: stored,
        effectiveSiteUrl: stored.siteUrl,
        siteUrlEditable: true,
        siteNameLinkedToNode: false,
        nodeId: null,
      }),
    ]);
    const settings = await fetchSiteSettings(client);
    expect(settings.siteUrlEditable).toBe(true);
    expect(settings.siteNameLinkedToNode).toBe(false);
    expect(settings.nodeId).toBeNull();
    expect(settings.effectiveSiteUrl).toBe(stored.siteUrl);
  });

  test('non-OK response throws', async () => {
    const client = new StubApiClient([jsonResponse({ error: 'nope' }, 500)]);
    await expect(fetchSiteSettings(client)).rejects.toThrow('Failed to load site settings');
  });
});
