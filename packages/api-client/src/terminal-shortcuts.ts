import type { TerminalShortcutSettings, UpdateTerminalShortcutSettingsRequest } from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson } from './json-mutation';

export const terminalShortcutsQueryKey = ['terminal-shortcuts'] as const;

type TerminalShortcutsEnvelope = { settings: TerminalShortcutSettings };

export async function fetchTerminalShortcuts(
  client: ApiClient = defaultApiClient
): Promise<TerminalShortcutSettings> {
  return requestJson<TerminalShortcutsEnvelope, TerminalShortcutSettings>(
    client,
    '/api/settings/terminal-shortcuts',
    {
      errorFallback: 'Failed to load terminal shortcuts',
      pick: (payload) => payload.settings,
    }
  );
}

export async function updateTerminalShortcuts(
  body: UpdateTerminalShortcutSettingsRequest,
  client: ApiClient = defaultApiClient
): Promise<TerminalShortcutSettings> {
  return requestJson<TerminalShortcutsEnvelope, TerminalShortcutSettings>(
    client,
    '/api/settings/terminal-shortcuts',
    {
      method: 'PATCH',
      body,
      errorFallback: 'Failed to save terminal shortcuts',
      pick: (payload) => payload.settings,
    }
  );
}
