import { describe, expect, test } from 'bun:test';
import type { WatchRuleDto } from '@tmex/shared';
import {
  type WatchDialogView,
  shouldPromptNotifPermission,
  watchDialogTitleKey,
} from './use-watch-dialog-model';

const rule = { id: 'r1', name: 'demo' } as WatchRuleDto;

describe('watchDialogTitleKey', () => {
  const cases: Array<[string, WatchDialogView, string]> = [
    ['list', { mode: 'list' }, 'watch.title'],
    ['create form', { mode: 'form', rule: null }, 'watch.form.createTitle'],
    ['edit form', { mode: 'form', rule }, 'watch.form.editTitle'],
    ['state', { mode: 'state', rule }, 'watch.state.title'],
  ];

  for (const [name, view, expected] of cases) {
    test(name, () => {
      expect(watchDialogTitleKey(view)).toBe(expected);
    });
  }
});

describe('shouldPromptNotifPermission', () => {
  const original = Reflect.get(globalThis, 'Notification') as unknown;

  const withPermission = (permission: NotificationPermission | undefined, run: () => void) => {
    if (permission === undefined) {
      Reflect.deleteProperty(globalThis, 'Notification');
    } else {
      Reflect.set(globalThis, 'Notification', { permission });
    }
    try {
      run();
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, 'Notification');
      } else {
        Reflect.set(globalThis, 'Notification', original);
      }
    }
  };

  test('prompts after creating a rule when permission is still default', () => {
    withPermission('default', () => {
      expect(shouldPromptNotifPermission(true)).toBe(true);
    });
  });

  test('stays silent when the rule was only updated', () => {
    withPermission('default', () => {
      expect(shouldPromptNotifPermission(false)).toBe(false);
    });
  });

  test('stays silent when permission is already granted or denied', () => {
    withPermission('granted', () => {
      expect(shouldPromptNotifPermission(true)).toBe(false);
    });
    withPermission('denied', () => {
      expect(shouldPromptNotifPermission(true)).toBe(false);
    });
  });

  test('stays silent when Notification is unavailable', () => {
    withPermission(undefined, () => {
      expect(shouldPromptNotifPermission(true)).toBe(false);
    });
  });
});
