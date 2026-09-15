import { getWindowOomMarkStore } from './oom-mark-store';
import { getWindowMemorySettingsStore } from './settings-store';
import type {
  WindowMemoryAggregate,
  WindowMemoryConnectionHooks,
  WindowMemoryTracker,
  WindowOomKillEvent,
} from './types';

export type { WindowMemoryTracker };

export type WindowMemoryListener = (windows: WindowMemoryAggregate[]) => void;

export type WindowMemoryConnectionRef = {
  windowMemory?: WindowMemoryTracker | null;
};

export function formatWindowOomKillWarn(event: WindowOomKillEvent): string {
  return (
    `[vibeterm][window-memory] oom_kill device=${event.deviceId}` +
    ` window=${event.windowId} pane=${event.paneId} scope=${event.scope}` +
    ` kills=${event.oomKills} current=${event.current} high=${event.high} max=${event.max}`
  );
}

export type WindowMemoryRuntimeAdapter = {
  hooks: WindowMemoryConnectionHooks;
  getWindows(): WindowMemoryAggregate[];
  supported(): boolean | null;
  subscribe(listener: WindowMemoryListener): () => void;
  tick(): Promise<void>;
};

export function createWindowMemoryRuntimeAdapter(
  getConnection: () => WindowMemoryConnectionRef
): WindowMemoryRuntimeAdapter {
  const listeners = new Set<WindowMemoryListener>();

  return {
    hooks: {
      getSettings: () => getWindowMemorySettingsStore().get(),
      get oomMarks() {
        return getWindowOomMarkStore();
      },
      onSample(windows) {
        for (const listener of listeners) listener(windows);
      },
      onOomKill(event) {
        console.warn(formatWindowOomKillWarn(event));
      },
    },
    getWindows() {
      return getConnection().windowMemory?.getWindows() ?? [];
    },
    supported() {
      return getConnection().windowMemory?.supported ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    tick() {
      return getConnection().windowMemory?.tick() ?? Promise.resolve();
    },
  };
}
