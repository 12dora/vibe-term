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

// 改名遗留 key 的一次性搬运：新 key 缺失时复制旧值，随后删掉旧 key。
export function migrateSidebarStorage(oldKey: string, newKey: string): void {
  try {
    const legacy = window.localStorage.getItem(oldKey);
    if (legacy === null) return;
    if (window.localStorage.getItem(newKey) === null) {
      window.localStorage.setItem(newKey, legacy);
    }
    window.localStorage.removeItem(oldKey);
  } catch {
    return;
  }
}
