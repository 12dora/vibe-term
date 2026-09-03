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

export interface NumericDraftPorts {
  /** 落到 store */
  commit: (next: number) => void;
  /** 通知宿主（React state）草稿变了 */
  onDraft: (raw: string) => void;
  min: () => number;
  max: () => number;
}

export interface NumericDraftController {
  change: (raw: string) => void;
  /** 失焦 / 回车：合法立刻提交，非法回灌已提交值 */
  commitNow: () => void;
  /** store 值被别处改掉时回灌草稿；自己刚提交的那次不回灌 */
  syncFromStore: (next: number) => void;
  /** 卸载（Escape 关 Sheet / 路由离开）：合法的待提交值必须落地，不能丢 */
  teardown: () => void;
}

export function createNumericDraft(
  initial: number,
  ports: NumericDraftPorts,
  delayMs: number = NUMERIC_DRAFT_COMMIT_MS
): NumericDraftController {
  let draft = String(initial);
  let committed = initial;

  const write = (next: number): void => {
    committed = next;
    ports.commit(next);
  };
  const deferred = createDeferredCommit(write, delayMs);
  const parse = (raw: string): number | null => parseNumericSetting(raw, ports.min(), ports.max());
  const setDraft = (raw: string): void => {
    draft = raw;
    ports.onDraft(raw);
  };

  return {
    change(raw) {
      setDraft(raw);
      const next = parse(raw);
      if (next === null || next === committed) {
        deferred.cancel();
        return;
      }
      deferred.schedule(next);
    },
    commitNow() {
      deferred.cancel();
      const next = parse(draft);
      if (next === null) {
        setDraft(String(committed));
        return;
      }
      if (next !== committed) write(next);
    },
    syncFromStore(next) {
      if (next === committed) return;
      committed = next;
      setDraft(String(next));
    },
    teardown() {
      deferred.flush();
    },
  };
}
