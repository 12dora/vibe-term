import {
  type LinkModifiers,
  type LinkOpenTrigger,
  NO_LINK_MODIFIERS,
  shouldOpenLink,
} from './link-open-policy';
import type { TerminalLinkHit } from './terminal-pointer-shared';
import type { TerminalDisposable } from './types';

function subscribe<T>(listeners: Set<T>, callback: T): TerminalDisposable {
  listeners.add(callback);
  return {
    dispose: () => {
      listeners.delete(callback);
    },
  };
}

function dispatch(listeners: Set<(target: string) => void>, target: string): boolean {
  for (const listener of listeners) {
    listener(target);
  }
  return listeners.size > 0;
}

// 链接激活出口：url 交给 onLinkActivated，file 交给 onFileLinkActivated（路径已解析为绝对路径）。
// 终端内部从不自行打开窗口或跳转。
export class TerminalLinkActivation {
  private readonly urlListeners = new Set<(url: string) => void>();
  private readonly fileListeners = new Set<(path: string) => void>();

  onUrl(callback: (url: string) => void): TerminalDisposable {
    return subscribe(this.urlListeners, callback);
  }

  onFile(callback: (path: string) => void): TerminalDisposable {
    return subscribe(this.fileListeners, callback);
  }

  /** 派发给对应监听器；没有任何监听器处理时返回 false（调用方不得当作已打开）。 */
  activate(hit: TerminalLinkHit): boolean {
    if (hit.kind === 'url') {
      return dispatch(this.urlListeners, hit.url);
    }
    return dispatch(this.fileListeners, hit.path);
  }

  /** 按链接策略判定后激活；返回是否确实交给了监听器。 */
  open(
    hit: TerminalLinkHit | null,
    trigger: LinkOpenTrigger,
    mouseReporting: boolean,
    modifiers: LinkModifiers = NO_LINK_MODIFIERS
  ): boolean {
    if (!hit || !shouldOpenLink({ hit, trigger, mouseReporting, modifiers })) {
      return false;
    }
    return this.activate(hit);
  }
}
