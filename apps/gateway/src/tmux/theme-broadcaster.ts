// 主题变化广播注册表：wsServer 持有各 device 的 runtime 连接，
// 但 api/theme.ts 无法直接引用 wsServer 实例（runtime 局部创建）。
// 仿 registerSnapshotLookup 的注册模式解耦。
//
// 两条广播路径：
// - tmux 侧：broadcastThemeChange → window-style + stdin 注入（已移除 stdin）
// - WS S2C 侧：broadcastSiteThemeUpdateS2C → 向所有 connected clients 发
//   KIND_SITE_THEME_UPDATE，与 WS C2S 路径一致（T10 已确保前端收到 S2C 不回送 C2S）

import type { ThemeMode } from '@tmex/shared';

type ThemeTmuxBroadcaster = (theme: ThemeMode) => void;
type ThemeS2CBroadcaster = (theme: ThemeMode) => void;

let tmuxBroadcaster: ThemeTmuxBroadcaster | null = null;
let s2cBroadcaster: ThemeS2CBroadcaster | null = null;

export function registerThemeBroadcaster(
  tmux: ThemeTmuxBroadcaster | null,
  s2c: ThemeS2CBroadcaster | null = null
): void {
  tmuxBroadcaster = tmux;
  s2cBroadcaster = s2c;
}

export function broadcastThemeChange(theme: ThemeMode): void {
  tmuxBroadcaster?.(theme);
}

export function broadcastSiteThemeUpdateS2C(theme: ThemeMode): void {
  s2cBroadcaster?.(theme);
}