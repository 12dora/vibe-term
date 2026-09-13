import {
  TERMINAL_SHORTCUT_ACTIONS,
  type TerminalShortcutAction,
  type TerminalShortcutItem,
} from '@vibeterm/shared';
import { flagString } from '../core/args';
import { type SubHandler, rejectExtra, requireArg } from '../core/cmd';
import { CliError, UsageError } from '../core/errors';
import { enabledFromFlags, requiredObjectBody, splitCsv } from '../core/settings-body';
import { jsonSelf, print } from './settings-http';

interface ShortcutDoc {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}

function parseShortcutKeys(raw: string): string {
  return raw.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_match, g: string) => {
    if (g[0] === 'x' && g.length === 3) {
      return String.fromCharCode(Number.parseInt(g.slice(1), 16));
    }
    if (g[0] === 'u' && g.length === 5) {
      return String.fromCharCode(Number.parseInt(g.slice(1), 16));
    }
    switch (g) {
      case 'r':
        return '\r';
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'e':
        return '\x1b';
      case '0':
        return '\x00';
      case 'a':
        return '\x07';
      case 'b':
        return '\x08';
      case 'f':
        return '\x0c';
      case 'v':
        return '\x0b';
      case '\\':
        return '\\';
      default:
        return g;
    }
  });
}

function shortcutDoc(payload: unknown): ShortcutDoc {
  if (!payload || typeof payload !== 'object') {
    throw new CliError('terminal shortcuts response is not an object');
  }
  const rec = payload as Record<string, unknown>;
  const settings =
    rec.settings && typeof rec.settings === 'object'
      ? (rec.settings as Record<string, unknown>)
      : rec;
  if (!Array.isArray(settings.items) || typeof settings.useIcons !== 'boolean') {
    throw new CliError('terminal shortcuts document is missing items/useIcons');
  }
  return { items: settings.items as TerminalShortcutItem[], useIcons: settings.useIcons };
}

async function loadShortcuts(ctx: Parameters<SubHandler>[0]): Promise<ShortcutDoc> {
  return shortcutDoc(await jsonSelf(ctx, 'GET', '/api/settings/terminal-shortcuts'));
}

async function saveShortcuts(ctx: Parameters<SubHandler>[0], doc: ShortcutDoc): Promise<unknown> {
  return jsonSelf(ctx, 'PATCH', '/api/settings/terminal-shortcuts', {
    items: doc.items,
    useIcons: doc.useIcons,
  });
}

function isAction(value: string): value is TerminalShortcutAction {
  return (TERMINAL_SHORTCUT_ACTIONS as readonly string[]).includes(value);
}

function newShortcut(flags: Parameters<SubHandler>[1]): TerminalShortcutItem {
  const keys = flagString(flags, 'keys');
  const label = flagString(flags, 'label');
  const icon = flagString(flags, 'icon');
  if (keys) {
    if (!label) throw new UsageError('shortcuts add requires --label');
    const payload = parseShortcutKeys(keys);
    if (!payload) throw new UsageError('--keys is empty');
    return { id: crypto.randomUUID(), type: 'send', label, payload };
  }
  if (icon && isAction(icon)) {
    return { id: crypto.randomUUID(), type: 'action', action: icon, label: label ?? '' };
  }
  throw new UsageError(
    'shortcuts add requires --label and --keys',
    'pass --keys "<seq>", or --icon paste|toggleKeyboard|newAgentSession|scrollToBottom'
  );
}

function removeShortcut(items: TerminalShortcutItem[], key: string): TerminalShortcutItem[] {
  if (items.some((item) => item.id === key)) {
    return items.filter((item) => item.id !== key);
  }
  const labeled = items.filter((item) => item.label === key);
  if (labeled.length === 1) {
    const id = labeled[0].id;
    return items.filter((item) => item.id !== id);
  }
  if (labeled.length > 1) {
    throw new UsageError(`shortcut label "${key}" is not unique`, 'pass the id');
  }
  throw new UsageError(`shortcut not found: ${key}`);
}

function orderShortcuts(
  items: TerminalShortcutItem[],
  idsRaw: string | undefined
): TerminalShortcutItem[] {
  const ids = splitCsv(idsRaw);
  if (ids.length === 0) {
    throw new UsageError('shortcuts order requires --ids', 'pass --ids a,b,c');
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const next: TerminalShortcutItem[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) throw new UsageError(`unknown shortcut id: ${id}`);
    if (seen.has(id)) throw new UsageError(`duplicate shortcut id: ${id}`);
    seen.add(id);
    next.push(item);
  }
  for (const item of items) {
    if (!seen.has(item.id)) next.push(item);
  }
  return next;
}

export const shortcuts: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'get|set|add|rm|order|use-icons');
  if (action === 'get') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/settings/terminal-shortcuts'));
    return;
  }
  if (action === 'set') {
    rejectExtra(positionals, 1);
    print(
      ctx,
      await jsonSelf(
        ctx,
        'PATCH',
        '/api/settings/terminal-shortcuts',
        await requiredObjectBody(flags, 'pass --body with { items, useIcons }')
      )
    );
    return;
  }
  if (action === 'add') {
    rejectExtra(positionals, 1);
    const nextItem = newShortcut(flags);
    const doc = await loadShortcuts(ctx);
    print(
      ctx,
      await saveShortcuts(ctx, { items: [...doc.items, nextItem], useIcons: doc.useIcons })
    );
    return;
  }
  if (action === 'rm') {
    const key = requireArg(positionals, 1, 'id or label');
    rejectExtra(positionals, 2);
    const doc = await loadShortcuts(ctx);
    print(
      ctx,
      await saveShortcuts(ctx, { items: removeShortcut(doc.items, key), useIcons: doc.useIcons })
    );
    return;
  }
  if (action === 'order') {
    rejectExtra(positionals, 1);
    const doc = await loadShortcuts(ctx);
    print(
      ctx,
      await saveShortcuts(ctx, {
        items: orderShortcuts(doc.items, flagString(flags, 'ids')),
        useIcons: doc.useIcons,
      })
    );
    return;
  }
  if (action === 'use-icons') {
    const useIcons = enabledFromFlags(flags, positionals[1]);
    const doc = await loadShortcuts(ctx);
    print(ctx, await saveShortcuts(ctx, { items: doc.items, useIcons }));
    return;
  }
  throw new UsageError(`unknown shortcuts action: ${action}`, 'use get|set|add|rm|order|use-icons');
};
