import type { TerminalLinkHit } from './terminal-pointer';
import type { TerminalDisposable } from './types';

// 控制器的对外事件出口：持有四组宿主回调，并把选择文本去重后广播（同时写 e2e 探针）。
// 与 WASM handle、DOM、渲染编排均无关，故独立于控制器持有。
export class TerminalListenerHub {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly selectionListeners = new Set<(text: string | null) => void>();
  private readonly linkListeners = new Set<(url: string) => void>();
  private readonly fileLinkListeners = new Set<(path: string) => void>();
  private lastNotifiedSelectionText: string | null = null;

  onData(callback: (data: string) => void): TerminalDisposable {
    return subscribe(this.dataListeners, callback);
  }

  onSelectionChange(callback: (text: string | null) => void): TerminalDisposable {
    return subscribe(this.selectionListeners, callback);
  }

  onLinkActivated(callback: (url: string) => void): TerminalDisposable {
    return subscribe(this.linkListeners, callback);
  }

  onFileLinkActivated(callback: (path: string) => void): TerminalDisposable {
    return subscribe(this.fileLinkListeners, callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  activateLink(hit: TerminalLinkHit): void {
    const listeners = hit.kind === 'url' ? this.linkListeners : this.fileLinkListeners;
    const target = hit.kind === 'url' ? hit.url : hit.path;
    for (const listener of listeners) {
      listener(target);
    }
  }

  updateSelectionTextProbe(value: string | null): void {
    (
      globalThis as { __tmexE2eTerminalSelectionText?: string | null }
    ).__tmexE2eTerminalSelectionText = value;

    if (value !== this.lastNotifiedSelectionText) {
      this.lastNotifiedSelectionText = value;
      for (const listener of this.selectionListeners) {
        listener(value);
      }
    }
  }
}

function subscribe<T>(listeners: Set<T>, callback: T): TerminalDisposable {
  listeners.add(callback);
  return {
    dispose: () => {
      listeners.delete(callback);
    },
  };
}
