import {
  DEFAULT_TERMINAL_SHORTCUTS,
  type TerminalShortcutItem,
  type TerminalShortcutSettings,
} from '@tmex/shared';
import { eq } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { toTerminalShortcutSettings } from './mappers';
import { terminalShortcutSettings } from './schema';

export function ensureTerminalShortcutSettingsInitialized(): void {
  const orm = getOrmDb();
  orm
    .insert(terminalShortcutSettings)
    .values({
      id: 1,
      items: DEFAULT_TERMINAL_SHORTCUTS,
      useIcons: false,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: terminalShortcutSettings.id })
    .run();
}

export function getTerminalShortcutSettings(): TerminalShortcutSettings {
  const orm = getOrmDb();
  let row = orm
    .select()
    .from(terminalShortcutSettings)
    .where(eq(terminalShortcutSettings.id, 1))
    .get();

  if (!row) {
    ensureTerminalShortcutSettingsInitialized();
    row = orm
      .select()
      .from(terminalShortcutSettings)
      .where(eq(terminalShortcutSettings.id, 1))
      .get();
  }

  if (!row) {
    throw new Error('terminal_shortcut_settings not initialized');
  }

  return toTerminalShortcutSettings(row);
}

export function updateTerminalShortcutSettings(updates: {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}): TerminalShortcutSettings {
  ensureTerminalShortcutSettingsInitialized();
  const next: TerminalShortcutSettings = {
    items: updates.items,
    useIcons: updates.useIcons,
    updatedAt: new Date().toISOString(),
  };

  const orm = getOrmDb();
  orm
    .update(terminalShortcutSettings)
    .set({
      items: next.items,
      useIcons: next.useIcons,
      updatedAt: next.updatedAt,
    })
    .where(eq(terminalShortcutSettings.id, 1))
    .run();

  return next;
}
