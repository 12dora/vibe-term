import type { EventType, WebhookEndpoint } from '@tmex/shared';
import { v4 as uuidv4 } from 'uuid';
import { createWebhookEndpoint, deleteWebhookEndpoint, getAllWebhookEndpoints } from '../db';
import { t } from '../i18n';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import {
  type ConfigFieldSpec,
  type FieldParseResult,
  applyConfigFields,
  parseBooleanField,
  parseStringArrayField,
} from './config-field';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function parseRequiredTrimmed(raw: unknown, error: string): FieldParseResult<string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, error };
  return { ok: true, value };
}

function parseWebhookUrlOrSecret(raw: unknown): FieldParseResult<string> {
  return parseRequiredTrimmed(raw, t('apiError.urlAndSecretRequired'));
}

function parseFlag(raw: unknown): FieldParseResult<boolean> {
  return parseBooleanField(raw, t('apiError.invalidRequest'));
}

function parseEventMask(raw: unknown): FieldParseResult<EventType[]> {
  const parsed = parseStringArrayField(raw, t('apiError.invalidRequest'));
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value as EventType[] };
}

type WebhookCreateDraft = {
  url: string;
  secret: string;
  enabled: boolean;
  eventMask: EventType[];
};

const WEBHOOK_CREATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'url', parse: parseWebhookUrlOrSecret, onAbsent: 'parse' },
  { name: 'secret', parse: parseWebhookUrlOrSecret, onAbsent: 'parse' },
  { name: 'enabled', parse: parseFlag, onAbsent: { default: true }, nullIsAbsent: true },
  { name: 'eventMask', parse: parseEventMask, onAbsent: { default: [] }, nullIsAbsent: true },
];

async function handleGetWebhooks(): Promise<Response> {
  const webhooks = getAllWebhookEndpoints();
  return json({ webhooks });
}

async function handleCreateWebhook(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const parsed = applyConfigFields<WebhookCreateDraft>(raw, WEBHOOK_CREATE_FIELDS, undefined);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const now = new Date().toISOString();
  const endpoint: WebhookEndpoint = {
    id: uuidv4(),
    enabled: parsed.fields.enabled,
    url: parsed.fields.url,
    secret: parsed.fields.secret,
    eventMask: parsed.fields.eventMask,
    createdAt: now,
    updatedAt: now,
  };

  createWebhookEndpoint(endpoint);
  broadcastSettingsUpdate('webhooks');

  return json({ webhook: endpoint }, 201);
}

async function handleDeleteWebhook(id: string): Promise<Response> {
  deleteWebhookEndpoint(id);
  broadcastSettingsUpdate('webhooks');
  return json({ success: true });
}

export const webhookRoutes: ApiRoute[] = [
  route({ method: 'GET', path: '/api/webhooks', handler: () => handleGetWebhooks() }),
  route({ method: 'POST', path: '/api/webhooks', handler: (req) => handleCreateWebhook(req) }),
  route({
    method: 'DELETE',
    path: '/api/webhooks/:id',
    handler: (_req, params) => handleDeleteWebhook(params.id),
  }),
];
