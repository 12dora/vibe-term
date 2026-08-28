// 沙箱 iframe / 隐私模式下访问 localStorage 会抛 SecurityError，一律降级为无操作，
// 否则侧栏宽度的初始化读取会直接打断整个 Provider 的首次渲染。
export function readSidebarStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSidebarStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

export function removeSidebarStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}
