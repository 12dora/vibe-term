import { describe, expect, test } from 'bun:test';

import { ThemeSubscriptionController, type ThemeSubscriptionHost } from './theme-subscription';
import type { CommandResult } from './types';

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function createHost(overrides: Partial<ThemeSubscriptionHost> = {}) {
  const sent: Array<{ paneId: string; data: string }> = [];
  const argvLog: string[][] = [];
  const host: ThemeSubscriptionHost = {
    connected: true,
    sendInput(paneId, data) {
      sent.push({ paneId, data });
    },
    async runTmuxAllowFailure(argv) {
      argvLog.push(argv);
      return ok();
    },
    ...overrides,
  };
  return { host, sent, argvLog };
}

describe('ThemeSubscriptionController', () => {
  test('signalThemeChange only notifies subscribed panes', () => {
    const { host, sent } = createHost();
    const controller = new ThemeSubscriptionController(host);
    controller.signalThemeChange('%1', 'dark');
    expect(sent).toEqual([]);

    controller.tracker.note('%1', true);
    controller.signalThemeChange('%1', 'dark');
    controller.signalThemeChange('%1', 'light');
    expect(sent).toEqual([
      { paneId: '%1', data: '\x1b[?997;1n' },
      { paneId: '%1', data: '\x1b[?997;2n' },
    ]);
  });

  test('signalThemeChange is a no-op when disconnected', () => {
    const { host, sent } = createHost({ connected: false });
    const controller = new ThemeSubscriptionController(host);
    controller.tracker.note('%1', true);
    controller.signalThemeChange('%1', 'dark');
    expect(sent).toEqual([]);
  });

  test('note and clear persist @tmex_2031 pane options', async () => {
    const { host, argvLog } = createHost();
    const controller = new ThemeSubscriptionController(host);
    controller.noteThemeSubscription('%1', true);
    controller.noteThemeSubscription('%1', false);
    controller.tracker.note('%2', true);
    controller.clearThemeSubscription('%2');
    controller.clearThemeSubscription('%3');
    await Bun.sleep(0);
    expect(argvLog.map((argv) => argv.join(' '))).toEqual([
      'set-option -p -t %1 @tmex_2031 on',
      'set-option -p -t %1 @tmex_2031 off',
      'set-option -p -t %2 @tmex_2031 off',
    ]);
    expect(controller.has('%2')).toBe(false);
  });

  test('restoreThemeSubscriptionsOnce hydrates from list-panes and runs only once', async () => {
    let calls = 0;
    const { host } = createHost({
      async runTmuxAllowFailure() {
        calls += 1;
        return ok('%1|on\n%2|off\n%3|on\n');
      },
    });
    const controller = new ThemeSubscriptionController(host);
    controller.restoreThemeSubscriptionsOnce();
    controller.restoreThemeSubscriptionsOnce();
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(controller.has('%1')).toBe(true);
    expect(controller.has('%2')).toBe(false);
    expect(controller.has('%3')).toBe(true);
  });
});
