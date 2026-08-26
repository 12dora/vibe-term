import type { TmuxSourceMetadataEvent } from '../events';
import type { ControlModeNotification } from './types';

export const RECONCILE_NOTIFICATION_TYPES = new Set(['sessions-changed', 'window-add']);

export function splitFirst(value: string): [string, string] {
  const index = value.indexOf(' ');
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
}

const SESSION_ID_RE = /^\$\d+$/;

export class ControlModeMetadataBridge {
  private lastSessionId: string | null = null;

  parse(notification: ControlModeNotification): TmuxSourceMetadataEvent | null {
    const [first, rest] = splitFirst(notification.args.trim());
    switch (notification.type) {
      case 'session-changed': {
        if (first) {
          this.lastSessionId = first;
        }
        return null;
      }
      case 'session-renamed': {
        if (first && rest && SESSION_ID_RE.test(first)) {
          this.lastSessionId = first;
          return { type: 'session-renamed', sessionId: first, name: rest };
        }
        const name = notification.args.trim();
        if (this.lastSessionId && name) {
          return { type: 'session-renamed', sessionId: this.lastSessionId, name };
        }
        return null;
      }
      case 'session-window-changed': {
        const [windowId] = splitFirst(rest);
        if (first && windowId) {
          return { type: 'session-window-changed', sessionId: first, windowId };
        }
        return null;
      }
      case 'window-renamed':
        if (first && rest) {
          return { type: 'window-renamed', windowId: first, name: rest };
        }
        return null;
      case 'window-pane-changed': {
        const [paneId] = splitFirst(rest);
        if (first && paneId) {
          return { type: 'window-pane-changed', windowId: first, paneId };
        }
        return null;
      }
      case 'layout-change': {
        const [layout] = splitFirst(rest);
        if (first && layout) {
          return { type: 'layout-change', windowId: first, layout };
        }
        return null;
      }
      case 'window-close':
      case 'unlinked-window-close':
        if (first) {
          return { type: 'window-close', windowId: first };
        }
        return null;
      case 'subscription-changed': {
        const separator = notification.args.indexOf(' : ');
        if (separator < 0) {
          return null;
        }
        const header = notification.args.slice(0, separator).trim().split(/\s+/);
        const name = header[0];
        const paneId = header.find((part) => /^%\d+$/.test(part));
        const value = notification.args.slice(separator + 3);
        if (!paneId) {
          return null;
        }
        if (name === 'tmex-cwd') {
          return { type: 'pane-current-path', paneId, currentPath: value };
        }
        if (name === 'tmex-command') {
          return { type: 'pane-current-command', paneId, currentCommand: value };
        }
        return null;
      }
      default:
        return null;
    }
  }
}
