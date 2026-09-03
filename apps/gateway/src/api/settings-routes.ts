import type {
  UpdateSiteSettingsRequest,
  UpdateTerminalShortcutSettingsRequest,
} from '@tmex/shared';
import { runtimeController } from '../control/runtime';
import {
  getStoredSiteSettings,
  getTerminalShortcutSettings,
  updateSiteSettings,
  updateTerminalShortcutSettings,
} from '../db';
import { t } from '../i18n';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { json } from './http';
import { type ApiRoute, route } from './route';
import { normalizeSiteSettingsInput } from './site-settings';
import {
  getSiteSettingsLinkProvider,
  sameManagedSiteUrl,
  toSiteSettingsHttpPayload,
} from './site-settings-link';
import { normalizeTerminalShortcutsInput } from './terminal-shortcuts';

function rejectManagedSiteIdentity(body: UpdateSiteSettingsRequest): Response | null {
  const link = getSiteSettingsLinkProvider();
  if (!link.linked()) return null;
  const current = toSiteSettingsHttpPayload(getStoredSiteSettings()).settings;
  if (body.siteUrl !== undefined) {
    const value = typeof body.siteUrl === 'string' ? body.siteUrl.trim() : '';
    if (!sameManagedSiteUrl(value, current.siteUrl)) {
      return json({ error: 'site_url_managed' }, 400);
    }
    body.siteUrl = undefined;
  }
  if (body.siteName !== undefined) {
    const value = typeof body.siteName === 'string' ? body.siteName.trim() : '';
    if (value !== current.siteName) {
      return json({ error: 'site_name_managed' }, 400);
    }
    body.siteName = undefined;
  }
  return null;
}

async function handleGetSiteSettings(): Promise<Response> {
  return json(toSiteSettingsHttpPayload(getStoredSiteSettings()));
}

async function handleUpdateSiteSettings(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as UpdateSiteSettingsRequest;
    const blocked = rejectManagedSiteIdentity(body);
    if (blocked) return blocked;
    const updates = normalizeSiteSettingsInput(body);
    const settings = updateSiteSettings(updates);
    broadcastSettingsUpdate('site');

    return json(toSiteSettingsHttpPayload(settings));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : t('apiError.invalidRequest') }, 400);
  }
}

async function handleGetTerminalShortcuts(): Promise<Response> {
  return json({ settings: getTerminalShortcutSettings() });
}

async function handleUpdateTerminalShortcuts(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as UpdateTerminalShortcutSettingsRequest;
    const updates = normalizeTerminalShortcutsInput(body);
    const settings = updateTerminalShortcutSettings(updates);
    broadcastSettingsUpdate('terminal-shortcuts');

    return json({ settings });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : t('apiError.invalidRequest') }, 400);
  }
}

async function handleRestartGateway(): Promise<Response> {
  setTimeout(() => {
    void runtimeController.requestRestart();
  }, 50);

  return json({
    success: true,
    message: t('settings.restartScheduled'),
  });
}

export const settingsRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/settings/site',
    handler: () => handleGetSiteSettings(),
  }),
  route({
    method: 'PATCH',
    path: '/api/settings/site',
    handler: (req) => handleUpdateSiteSettings(req),
  }),
  route({
    method: 'GET',
    path: '/api/settings/terminal-shortcuts',
    handler: () => handleGetTerminalShortcuts(),
  }),
  route({
    method: 'PATCH',
    path: '/api/settings/terminal-shortcuts',
    handler: (req) => handleUpdateTerminalShortcuts(req),
  }),
  route({
    method: 'POST',
    path: '/api/settings/restart',
    handler: () => handleRestartGateway(),
  }),
];
