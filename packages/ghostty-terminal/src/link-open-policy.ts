import { isMacPlatform } from './selection-clipboard';
import type { TerminalLinkHit } from './terminal-pointer-shared';

/**
 * press：主键按下；release：主键松开（按下与松开在同一格）；hover：悬停光标；tap：触屏轻点。
 */
export type LinkOpenTrigger = 'press' | 'release' | 'hover' | 'tap';

/**
 * platform：平台主修饰键（Mac Cmd / 其它 Ctrl）且未按 Alt；other：Alt 或非平台的 Ctrl/Meta。
 */
export type LinkModifiers = { platform: boolean; other: boolean; shift: boolean };

export const NO_LINK_MODIFIERS: LinkModifiers = { platform: false, other: false, shift: false };

export type LinkOpenInput = {
  hit: TerminalLinkHit | null;
  trigger: LinkOpenTrigger;
  mouseReporting: boolean;
  modifiers: LinkModifiers;
};

export function classifyLinkModifiers(event: {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): LinkModifiers {
  const mac = isMacPlatform();
  const platformKey = mac ? event.metaKey : event.ctrlKey;
  const otherKey = mac ? event.ctrlKey : event.metaKey;
  return {
    platform: platformKey && !event.altKey,
    other: event.altKey || otherKey,
    shift: event.shiftKey,
  };
}

// 链接打开策略的唯一判定点：鼠标按下/松开、悬停光标与触屏轻点都经由这里。
// - Shift 保留 xterm 语义（绕过上报走本地选择），Alt 与非平台修饰键留给应用：都不打开。
// - 平台修饰键 + 按下：任何链接立即打开，无视鼠标上报；此时松开不再打开。
// - 无任何修饰的单击（松开时判定）/ 轻点：上报关闭时打开任何链接；上报开启时只打开 OSC 8
//   链接，正则检测到的链接仍交给应用（vim/htop 的点击定位不受影响）。
// - 悬停：按住平台修饰键时任一链接都显示可点击，否则与无修饰单击一致。
export function shouldOpenLink(input: LinkOpenInput): boolean {
  const { hit, modifiers } = input;
  if (!hit || modifiers.shift || modifiers.other) {
    return false;
  }
  const plainOpens = !input.mouseReporting || hit.explicit;
  switch (input.trigger) {
    case 'press':
      return modifiers.platform;
    case 'release':
      return !modifiers.platform && plainOpens;
    case 'hover':
      return modifiers.platform || plainOpens;
    default:
      return plainOpens;
  }
}
