import type { TerminalThemeColors } from '@tmex/shared';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import type { ReactNode } from 'react';

/**
 * 终端配色入参：'light' | 'dark' 是历史写法（走 seoul256 双主题），
 * 主题预设生效时宿主直接传解析好的整套色板（@tmex/theme 的 resolveTerminalTheme）。
 */
export type TerminalTheme = 'light' | 'dark' | TerminalThemeColors;

export interface TerminalProps {
  deviceId: string;
  paneId: string;
  theme: TerminalTheme;
  inputMode: 'direct' | 'editor';
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  /**
   * report（默认）：容器尺寸变化上报 onResize/onSync（单 pane 整窗语义）。
   * follow：分屏模式，尺寸由 tmux layout 经外部 resize() 设定，不测量不上报。
   * local：保活池里的隐藏实例，照常测量并对齐本地行列，但不上报（避免多实例互抢整窗尺寸）。
   */
  sizingMode?: 'report' | 'follow' | 'local';
  /**
   * follower（他人拥有 PTY 尺寸）时打开平移视口：本地保留权威 cols×rows 完整绘制，
   * 超出容器的部分由 .xterm-viewport 双向滚动承载。默认 false = 与以往一致的裁剪语义。
   */
  viewportPan?: boolean;
  /** direct 模式挂载时是否自动聚焦（默认 true）；分屏非焦点 pane 传 false 防互抢 */
  autoFocus?: boolean;
  onData?: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
  onResizeSettled?: (cols: number, rows: number) => void;
  /** 文件链接点击回调（逃生门）；不传则默认走 runtime.host.navigate + fileRoute */
  onOpenFile?: (rootId: string, path: string) => void;
  /** 拼接在终端容器最下方的内容（如快捷键栏），会占据终端可视区域下方的空间 */
  children?: ReactNode;
  /** 该 pane 是否为焦点（分屏下控制滚动条可见性） */
  focused?: boolean;
  /**
   * 宿主按需准备字体/WASM 等非首屏资源；缺省由 Terminal 自行加载选中字体。
   * 无事可做时返回 undefined（而不是 Promise.resolve()），启动路径据此完全同步。
   */
  prepareResources?: () => Promise<void> | void;
}

export interface TerminalRef {
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  scrollToBottom: () => void;
  resize: (cols: number, rows: number) => void;
  getTerminal: () => CompatibleTerminalLike | null;
  getSize: () => { cols: number; rows: number } | null;
  runPostSelectResize: () => void;
  scheduleResize: (
    kind: 'resize' | 'sync',
    options?: { immediate?: boolean; force?: boolean }
  ) => void;
  /**
   * 基于容器 DOM 尺寸计算行列数
   * 返回根据容器实际尺寸计算出的 cols/rows，而不是当前 xterm 实例的尺寸
   */
  calculateSizeFromContainer: () => { cols: number; rows: number } | null;
  getPendingLocalSize: () => { cols: number; rows: number; at: number } | null;
  clearPendingLocalSize: () => void;
  /** 当前渲染 cell 的 CSS 像素尺寸（分屏几何换算用），渲染服务未就绪时返回 null */
  getCellSize: () => { width: number; height: number } | null;
}
