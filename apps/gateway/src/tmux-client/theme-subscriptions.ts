// mode 2031 主题订阅状态（纯内存，持久化/恢复由 connection 层经 @tmex_2031 pane 选项完成）。
// 订阅来自 pane 输出流中的 CSI ?2031h/l；清位信号：?2031l、提示符标记（前台回到 shell）、
// pane 消失（prune）、连接销毁。

export interface ThemeSubscriptionTracker {
  note(paneId: string, subscribed: boolean): void;
  clear(paneId: string): void;
  prune(validPaneIds: ReadonlySet<string>): void;
  restore(paneIds: Iterable<string>): void;
  has(paneId: string): boolean;
  list(): string[];
  reset(): void;
}

export function createThemeSubscriptionTracker(): ThemeSubscriptionTracker {
  const subscribed = new Set<string>();

  return {
    note(paneId, isSubscribed) {
      if (isSubscribed) {
        subscribed.add(paneId);
      } else {
        subscribed.delete(paneId);
      }
    },
    clear(paneId) {
      subscribed.delete(paneId);
    },
    prune(validPaneIds) {
      for (const paneId of subscribed) {
        if (!validPaneIds.has(paneId)) {
          subscribed.delete(paneId);
        }
      }
    },
    restore(paneIds) {
      for (const paneId of paneIds) {
        subscribed.add(paneId);
      }
    },
    has(paneId) {
      return subscribed.has(paneId);
    },
    list() {
      return [...subscribed];
    },
    reset() {
      subscribed.clear();
    },
  };
}
