import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Server } from 'bun';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { ensureSiteSettingsInitialized } from '../db';
import { getDb as getOrmDb } from '../db/client';
import * as telegramDb from '../db/telegram';
import { t } from '../i18n';
import { telegramRoutes, webhookRoutes } from './messaging-routes';
import { type ApiRoute, dispatchRoutes } from './route';

const fakeServer = {} as Server<unknown>;
const spies: Array<{ mockRestore: () => void }> = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
});

afterEach(() => {
  while (spies.length > 0) {
    spies.pop()?.mockRestore();
  }
});

function req(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function dispatch(routes: readonly ApiRoute[], method: string, path: string, body: unknown) {
  const request = req(method, path, body);
  const response = dispatchRoutes(request, path, routes, { server: fakeServer, path });
  if (!response) {
    throw new Error(`no handler matched: ${method} ${path}`);
  }
  return response;
}

async function expectInvalid(
  routes: readonly ApiRoute[],
  method: string,
  path: string,
  body: unknown,
  error: string
) {
  const response = await dispatch(routes, method, path, body);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error });
}

const fakeBot = {
  id: 'bot-body-guard',
  name: 'bot',
  tokenEnc: 'enc',
  enabled: true,
  allowAuthRequests: true,
  allowCommands: false,
  lastUpdateId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('telegram JSON body validation', () => {
  test('POST /api/settings/telegram/bots rejects null body', async () => {
    await expectInvalid(
      telegramRoutes,
      'POST',
      '/api/settings/telegram/bots',
      null,
      t('apiError.invalidRequest')
    );
  });

  test('POST /api/settings/telegram/bots rejects wrong-type fields', async () => {
    await expectInvalid(
      telegramRoutes,
      'POST',
      '/api/settings/telegram/bots',
      { name: 42, token: 'tok' },
      t('apiError.botNameRequired')
    );
    await expectInvalid(
      telegramRoutes,
      'POST',
      '/api/settings/telegram/bots',
      { name: 'bot', token: 42 },
      t('apiError.botTokenRequired')
    );
    await expectInvalid(
      telegramRoutes,
      'POST',
      '/api/settings/telegram/bots',
      { name: 'bot', token: 'tok', enabled: 'yes' },
      t('apiError.invalidRequest')
    );
    await expectInvalid(
      telegramRoutes,
      'POST',
      '/api/settings/telegram/bots',
      { name: 'bot', token: 'tok', allowAuthRequests: 1 },
      t('apiError.invalidRequest')
    );
    await expectInvalid(
      telegramRoutes,
      'POST',
      '/api/settings/telegram/bots',
      { name: 'bot', token: 'tok', allowCommands: 1 },
      t('apiError.invalidRequest')
    );
  });

  test('PATCH /api/settings/telegram/bots/:botId rejects null body', async () => {
    track(spyOn(telegramDb, 'getTelegramBotById').mockReturnValue(fakeBot));
    await expectInvalid(
      telegramRoutes,
      'PATCH',
      '/api/settings/telegram/bots/bot-body-guard',
      null,
      t('apiError.invalidRequest')
    );
  });

  test('PATCH /api/settings/telegram/bots/:botId rejects wrong-type fields', async () => {
    track(spyOn(telegramDb, 'getTelegramBotById').mockReturnValue(fakeBot));
    await expectInvalid(
      telegramRoutes,
      'PATCH',
      '/api/settings/telegram/bots/bot-body-guard',
      { name: 42 },
      t('apiError.botNameRequired')
    );
    await expectInvalid(
      telegramRoutes,
      'PATCH',
      '/api/settings/telegram/bots/bot-body-guard',
      { token: 42 },
      t('apiError.botTokenRequired')
    );
    await expectInvalid(
      telegramRoutes,
      'PATCH',
      '/api/settings/telegram/bots/bot-body-guard',
      { enabled: 'yes' },
      t('apiError.invalidRequest')
    );
    await expectInvalid(
      telegramRoutes,
      'PATCH',
      '/api/settings/telegram/bots/bot-body-guard',
      { allowCommands: 'yes' },
      t('apiError.invalidRequest')
    );
  });
});

describe('webhook JSON body validation', () => {
  test('POST /api/webhooks rejects null body', async () => {
    await expectInvalid(webhookRoutes, 'POST', '/api/webhooks', null, t('apiError.invalidRequest'));
  });

  test('POST /api/webhooks rejects wrong-type fields', async () => {
    await expectInvalid(
      webhookRoutes,
      'POST',
      '/api/webhooks',
      { url: 42, secret: 's' },
      t('apiError.urlAndSecretRequired')
    );
    await expectInvalid(
      webhookRoutes,
      'POST',
      '/api/webhooks',
      { url: 'https://example.test/hook', secret: 42 },
      t('apiError.urlAndSecretRequired')
    );
    await expectInvalid(
      webhookRoutes,
      'POST',
      '/api/webhooks',
      { url: 'https://example.test/hook', secret: 's', enabled: 'yes' },
      t('apiError.invalidRequest')
    );
    await expectInvalid(
      webhookRoutes,
      'POST',
      '/api/webhooks',
      { url: 'https://example.test/hook', secret: 's', eventMask: 42 },
      t('apiError.invalidRequest')
    );
  });
});
