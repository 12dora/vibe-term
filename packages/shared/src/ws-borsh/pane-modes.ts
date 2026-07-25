// pane 终端模式位图（TermHistory.modes）。
//
// capture-pane 快照只含屏幕文本与 SGR 颜色，不含 DECSET 私有模式序列；tmux control
// mode 的 %output 也只在 TUI 启动瞬间转发过一次 DECSET。因此切窗/刷新后重建内容时，
// 鼠标 tracking / 编码模式的唯一权威来源是 tmux 的 pane format 变量
// （mouse_standard_flag 等），由 gateway 随 history 一起下发，前端据此恢复。
export const PANE_MODE_MOUSE_STANDARD = 1 << 0; // DECSET 1000（press/release）
export const PANE_MODE_MOUSE_BUTTON = 1 << 1; // DECSET 1002（含按住拖拽 motion）
export const PANE_MODE_MOUSE_ALL = 1 << 2; // DECSET 1003（任意 motion）
export const PANE_MODE_MOUSE_SGR = 1 << 3; // DECSET 1006（SGR 编码）
export const PANE_MODE_MOUSE_UTF8 = 1 << 4; // DECSET 1005（UTF-8 编码）
// canonical ScreenBegin 的 modes 位图在 mouse 位之上追加两个标志位：
// bit5 = alternate screen（快照数据前缀已带 \x1b[?1049h，此位仅供恢复 altScroll 等派生模式）；
// bit7 = 位图有效标志。旧版 gateway 曾把 alternate_on 布尔值直接写进 bit0，与
// PANE_MODE_MOUSE_STANDARD 语义撞车——消费端必须先验 bit7 再解码 mouse 位，避免
// 新客户端把旧 gateway 的 alt 屏标志误当鼠标模式恢复。
export const PANE_MODE_ALT_SCREEN = 1 << 5;
export const PANE_MODE_FLAGS_PRESENT = 1 << 7;

export interface PaneModeFlags {
  mouseStandard: boolean;
  mouseButton: boolean;
  mouseAll: boolean;
  mouseSgr: boolean;
  mouseUtf8: boolean;
}

export const EMPTY_PANE_MODE_FLAGS: PaneModeFlags = {
  mouseStandard: false,
  mouseButton: false,
  mouseAll: false,
  mouseSgr: false,
  mouseUtf8: false,
};

export function encodePaneModes(flags: PaneModeFlags): number {
  return (
    (flags.mouseStandard ? PANE_MODE_MOUSE_STANDARD : 0) |
    (flags.mouseButton ? PANE_MODE_MOUSE_BUTTON : 0) |
    (flags.mouseAll ? PANE_MODE_MOUSE_ALL : 0) |
    (flags.mouseSgr ? PANE_MODE_MOUSE_SGR : 0) |
    (flags.mouseUtf8 ? PANE_MODE_MOUSE_UTF8 : 0)
  );
}

export function decodePaneModes(bits: number): PaneModeFlags {
  return {
    mouseStandard: (bits & PANE_MODE_MOUSE_STANDARD) !== 0,
    mouseButton: (bits & PANE_MODE_MOUSE_BUTTON) !== 0,
    mouseAll: (bits & PANE_MODE_MOUSE_ALL) !== 0,
    mouseSgr: (bits & PANE_MODE_MOUSE_SGR) !== 0,
    mouseUtf8: (bits & PANE_MODE_MOUSE_UTF8) !== 0,
  };
}
