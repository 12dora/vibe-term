// 数字设置项的「本地草稿 → 延后提交」接线。
//
// 终端字号 / 行高每提交一次都会重建全部已挂载的 ghostty 实例（`useTerminalBootSurface` 的
// effect 依赖含这两个值），面板又常挂在设备页工具栏上、下面就是活着的终端。按住数字框的
// 上下箭头约 30 次/秒，即改即提交等于每秒 30 轮「dispose + 重建 + 重放 history」。
// 提交因此必须与输入解耦：输入只动草稿，提交走失焦 / 回车 / 停手后的延时窗口。

export const NUMERIC_DRAFT_COMMIT_MS = 250;

/** 落在 [min, max] 内的有限数才是可提交值；空串与越界一律返回 null。 */
export function parseNumericSetting(raw: string, min: number, max: number): number | null {
  const next = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(next) || next < min || next > max) {
    return null;
  }
  return next;
}

export interface DeferredCommit<T> {
  /** 重排延时窗口；窗口内的多次调用只会提交最后一个值。 */
  schedule: (value: T) => void;
  /** 立刻提交待提交值（没有就什么都不做）。 */
  flush: () => void;
  cancel: () => void;
}

export function createDeferredCommit<T>(
  commit: (value: T) => void,
  delayMs: number = NUMERIC_DRAFT_COMMIT_MS
): DeferredCommit<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  const flush = () => {
    if (!pending) return;
    const { value } = pending;
    cancel();
    commit(value);
  };

  return {
    schedule(value: T) {
      pending = { value };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel,
  };
}
