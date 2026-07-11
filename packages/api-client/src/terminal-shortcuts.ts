import type { TerminalShortcutSettings, UpdateTerminalShortcutSettingsRequest } from '@tmex/shared';
import { type ApiClient, defaultApiClient, parseApiError } from './client';

export const terminalShortcutsQueryKey = ['terminal-shortcuts'] as const;

export async function fetchTerminalShortcuts(
  client: ApiClient = defaultApiClient
): Promise<TerminalShortcutSettings> {
  const res = await client.fetch('/api/settings/terminal-shortcuts');
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load terminal shortcuts'));
  }
  const payload = (await res.json()) as { settings: TerminalShortcutSettings };
  return payload.settings;
}

export async function updateTerminalShortcuts(
  body: UpdateTerminalShortcutSettingsRequest,
  client: ApiClient = defaultApiClient
): Promise<TerminalShortcutSettings> {
  const res = await client.fetch('/api/settings/terminal-shortcuts', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to save terminal shortcuts'));
  }
  const payload = (await res.json()) as { settings: TerminalShortcutSettings };
  return payload.settings;
}
