import type { ThemeMode } from '@tmex/shared';
import { getSiteSettings, updateSiteSettings } from '../db';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { broadcastSiteThemeUpdateS2C, broadcastThemeChange } from '../tmux/theme-broadcaster';
import { json } from './http';

const VALID_THEMES: readonly ThemeMode[] = ['dark', 'light'];

export function handleThemeApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | null {
  if (path === '/api/settings/theme' && req.method === 'GET') {
    return handleGetTheme();
  }
  if (path === '/api/settings/theme' && req.method === 'POST') {
    return handleUpdateTheme(req);
  }
  return null;
}

function handleGetTheme(): Response {
  const settings = getSiteSettings();
  return json({ theme: settings.theme, serverTimestamp: Date.now() });
}

async function handleUpdateTheme(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid request body' }, 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ error: 'invalid request body' }, 400);
  }

  const { theme } = body as { theme?: unknown };

  if (typeof theme !== 'string' || !VALID_THEMES.includes(theme as ThemeMode)) {
    return json({ error: 'theme must be one of: dark, light' }, 400);
  }

  const serverTimestamp = Date.now();
  updateSiteSettings({ theme: theme as ThemeMode });
  broadcastThemeChange(theme as ThemeMode);
  broadcastSiteThemeUpdateS2C(theme as ThemeMode);
  broadcastSettingsUpdate('theme');

  return json({ theme: theme as ThemeMode, serverTimestamp });
}
