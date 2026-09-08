import { LINE_HEIGHT } from './terminal-constants';
import type { GhosttyTerminalInitOptions } from './types';

// 终端 DOM 元素工厂：按初始化选项建出元素树的各个节点并写死静态样式，不持有状态。
// 抽出来是为了让 terminal-dom.ts 专注几何测量与状态化的样式写入。

export function createRootElement(options: GhosttyTerminalInitOptions): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'xterm';
  root.style.position = 'absolute';
  root.style.inset = '0';
  root.style.overflow = 'hidden';
  // 终端子树自成布局/绘制/样式隔离单元：滚动条与 canvas 层的样式写入不再让整份文档的
  // 布局树失效，残余的强制同步布局也被限制在这棵子树内。root 本身已是 overflow:hidden
  // 的绝对定位块，paint 隔离不改变任何可见裁剪与包含块语义。
  root.style.contain = 'layout paint style';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.backgroundColor = options.theme.background;
  root.style.color = options.theme.foreground;
  root.style.fontFamily = options.fontFamily;
  root.style.fontSize = `${options.fontSize}px`;
  root.style.lineHeight = String(options.lineHeight ?? LINE_HEIGHT);
  return root;
}

export function createViewportElement(): HTMLDivElement {
  const viewport = document.createElement('div');
  viewport.className = 'xterm-viewport';
  viewport.style.width = '100%';
  viewport.style.height = '100%';
  viewport.style.overflow = 'hidden';
  viewport.style.position = 'relative';
  return viewport;
}

export function createScreenElement(options: GhosttyTerminalInitOptions): HTMLDivElement {
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  screen.style.width = '100%';
  screen.style.height = '100%';
  screen.style.position = 'relative';
  screen.style.userSelect = 'none';
  screen.style.webkitUserSelect = 'none';
  screen.style.backgroundColor = options.theme.background;
  return screen;
}

export function createTextareaElement(options: GhosttyTerminalInitOptions): HTMLDivElement {
  const textarea = document.createElement('div');
  textarea.className = 'xterm-helper-textarea';
  textarea.setAttribute('aria-label', 'Terminal Input');
  textarea.setAttribute('role', 'textbox');
  textarea.setAttribute('contenteditable', 'true');
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('spellcheck', 'false');
  textarea.style.position = 'absolute';
  textarea.style.opacity = '1';
  textarea.style.pointerEvents = 'none';
  textarea.style.left = '0';
  textarea.style.top = '0';
  textarea.style.minWidth = '1px';
  textarea.style.minHeight = '1px';
  textarea.style.whiteSpace = 'pre';
  textarea.style.border = '0';
  textarea.style.padding = '0';
  textarea.style.margin = '0';
  textarea.style.color = options.theme.foreground;
  textarea.style.backgroundColor = 'transparent';
  textarea.style.caretColor = 'transparent';
  textarea.style.overflow = 'visible';
  textarea.style.outline = 'none';
  textarea.style.boxShadow = 'none';
  textarea.style.fontFamily = options.fontFamily;
  textarea.style.fontSize = `${options.fontSize}px`;
  textarea.style.userSelect = 'text';
  textarea.style.webkitUserSelect = 'text';
  return textarea;
}

export function createScrollbarElements(): { track: HTMLDivElement; thumb: HTMLDivElement } {
  const track = document.createElement('div');
  track.className = 'xterm-scrollbar-track';
  track.style.position = 'absolute';
  track.style.top = '0';
  track.style.right = '0';
  track.style.width = '8px';
  track.style.height = '100%';
  track.style.backgroundColor = 'transparent';
  track.style.pointerEvents = 'none';

  const thumb = document.createElement('div');
  thumb.className = 'xterm-scrollbar-thumb';
  thumb.style.position = 'absolute';
  thumb.style.top = '0';
  thumb.style.right = '0';
  thumb.style.width = '6px';
  thumb.style.marginRight = '1px';
  thumb.style.borderRadius = '3px';
  thumb.style.backgroundColor = 'rgba(128, 128, 128, 0.5)';
  thumb.style.pointerEvents = 'none';
  thumb.style.transition = 'opacity 0.15s ease';
  thumb.style.opacity = '0';

  track.appendChild(thumb);
  return { track, thumb };
}
