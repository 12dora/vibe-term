import { config } from '../../config';
import {
  type ThemeSubscriptionTracker,
  createThemeSubscriptionTracker,
} from '../theme-subscriptions';
import type { CommandResult } from './types';

export interface ThemeSubscriptionHost {
  connected: boolean;
  sendInput(paneId: string, data: string): void;
  runTmuxAllowFailure(argv: string[]): Promise<CommandResult>;
}

export class ThemeSubscriptionController {
  readonly tracker: ThemeSubscriptionTracker = createThemeSubscriptionTracker();
  private restored = false;

  constructor(private readonly host: ThemeSubscriptionHost) {}

  has(paneId: string): boolean {
    return this.tracker.has(paneId);
  }

  prune(paneIds: ReadonlySet<string>): void {
    this.tracker.prune(paneIds);
  }

  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void {
    if (!this.host.connected || !config.themeNotify2031Enabled) {
      return;
    }
    if (!this.tracker.has(paneId)) {
      return;
    }
    this.host.sendInput(paneId, `\x1b[?997;${theme === 'dark' ? '1' : '2'}n`);
  }

  noteThemeSubscription(paneId: string, subscribed: boolean): void {
    this.tracker.note(paneId, subscribed);
    void this.host
      .runTmuxAllowFailure([
        'set-option',
        '-p',
        '-t',
        paneId,
        '@tmex_2031',
        subscribed ? 'on' : 'off',
      ])
      .catch(() => {});
  }

  clearThemeSubscription(paneId: string): void {
    if (!this.tracker.has(paneId)) {
      return;
    }
    this.tracker.clear(paneId);
    void this.host
      .runTmuxAllowFailure(['set-option', '-p', '-t', paneId, '@tmex_2031', 'off'])
      .catch(() => {});
  }

  restoreThemeSubscriptionsOnce(): void {
    if (this.restored) {
      return;
    }
    this.restored = true;
    void this.host
      .runTmuxAllowFailure(['list-panes', '-a', '-F', '#{pane_id}|#{@tmex_2031}'])
      .then((result) => {
        if (!result || result.exitCode !== 0) {
          return;
        }
        const restored: string[] = [];
        for (const line of result.stdout.split('\n')) {
          const [paneId, flag] = line.trim().split('|');
          if (paneId && flag === 'on') {
            restored.push(paneId);
          }
        }
        this.tracker.restore(restored);
      })
      .catch(() => {});
  }
}
