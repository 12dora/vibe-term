import type {
  UpdateSiteSettingsRequest,
  UpdateTerminalShortcutSettingsRequest,
} from '@tmex/shared';
import { runtimeController } from '../control/runtime';
import {
  getSiteSettings,
  getTerminalShortcutSettings,
  updateSiteSettings,
  updateTerminalShortcutSettings,
} from '../db';
import { t } from '../i18n';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { json } from './http';
import { type ApiRoute, route } from './route';
import { normalizeSiteSettingsInput } from './site-settings';
import { normalizeTerminalShortcutsInput } from './terminal-shortcuts';
import { handleThemeApiRequest } from './theme';

async function handleGetSiteSettings(): Promise<Response> {
  return json({ settings: getSiteSettings() });
}

async function handleUpdateSiteSettings(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as UpdateSiteSettingsRequest;
    const updates = normalizeSiteSettingsInput(body);
    const settings = updateSiteSettings(updates);
    broadcastSettingsUpdate('site');

    return json({ settings });
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
    method: ['GET', 'POST'],
    path: '/api/settings/theme',
    handler: (req, _params, ctx) => handleThemeApiRequest(req, ctx.path),
  }),
  route({
    method: 'POST',
    path: '/api/settings/restart',
    handler: () => handleRestartGateway(),
  }),
];
