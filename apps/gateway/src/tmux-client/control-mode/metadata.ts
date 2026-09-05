import type { TmuxSourceMetadataEvent } from '../events';
import { PARKING_WINDOW_NAME } from '../external/constants';
import type { ControlModeNotification } from './types';

/** 同时活着的护盾窗口只会有一个；留几个槽位兜住清理失败的历史 id，同时避免无界增长。 */
const PARKING_WINDOW_MEMORY = 4;

export const RECONCILE_NOTIFICATION_TYPES = new Set(['sessions-changed', 'window-add']);

export function splitFirst(value: string): [string, string] {
  const index = value.indexOf(' ');
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
}

export class ControlModeMetadataBridge {
  private lastSessionId: string | null = null;
  private readonly parkingWindowIds = new Set<string>();

  /**
   * 记下本次 attach 建的 `tmex-park` 窗口：它只活几秒，它的激活 / 改名 / 关闭事件
   * 一旦外泄，前端「跟随活动窗口」就会被拉进去，再随它被杀而看起来像 tab 自己消失。
   */
  noteParkingWindow(windowId: string | null): void {
    if (!windowId) {
      return;
    }
    this.parkingWindowIds.add(windowId);
    while (this.parkingWindowIds.size > PARKING_WINDOW_MEMORY) {
      const oldest = this.parkingWindowIds.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.parkingWindowIds.delete(oldest);
    }
  }

  isParkingWindow(windowId: string): boolean {
    return this.parkingWindowIds.has(windowId);
  }

  private parseSessionWindowChanged(
    sessionId: string,
    windowId: string
  ): TmuxSourceMetadataEvent | null {
    if (!sessionId || !windowId || this.parkingWindowIds.has(windowId)) {
      return null;
    }
    return { type: 'session-window-changed', sessionId, windowId };
  }

  private parseWindowRenamed(windowId: string, name: string): TmuxSourceMetadataEvent | null {
    if (name === PARKING_WINDOW_NAME) {
      this.noteParkingWindow(windowId);
      return null;
    }
    if (!windowId || !name || this.parkingWindowIds.has(windowId)) {
      return null;
    }
    return { type: 'window-renamed', windowId, name };
  }

  private parseWindowClose(windowId: string): TmuxSourceMetadataEvent | null {
    if (!windowId || this.parkingWindowIds.delete(windowId)) {
      return null;
    }
    return { type: 'window-close', windowId };
  }

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
        const name = notification.args.trim();
        if (this.lastSessionId && name) {
          return { type: 'session-renamed', sessionId: this.lastSessionId, name };
        }
        return null;
      }
      case 'session-window-changed':
        return this.parseSessionWindowChanged(first, splitFirst(rest)[0]);
      case 'window-renamed':
        return this.parseWindowRenamed(first, rest);
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
        return this.parseWindowClose(first);
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
