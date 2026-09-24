// 设备页右上角的窗口内存徽标：当前窗口的内存合计。
//
// 数据与链路徽标分开走：链路按 node，内存按「设备 + 当前路由选中的窗口」。量不到内存
// （网关没播报 window-memory-v1 / 采样一直取不到数）时整块不渲染，而不是显示一个恒为 0 的读数。
//
// 读数有两种来源：`cgroup` 来自 pane 的 systemd scope，限额与 OOM 计数都可信；`rss` 是宿主
// 没有 pane scope（tmux < 3.6 或没带 systemd 支持、macOS）时按 pane 进程树 RSS 合计的兜底，
// 这条路径上**没有任何限额**，不能拿「未设限」的 ∞ 去糊弄——提示里要说清楚。
//
// 网关会在设备重连时重放缓存的读数，采样停摆时那份读数可能是几天前的：到达时就已过期的读数
// 一律灰显，提示里只说「读数已过期」，不再列出旧限额，也不再按旧限额变色。

import { formatRelative } from '@/lib/format-relative';
import { TONE_CLASS } from '@/lib/tone';
import { formatBytes } from '@vibeterm/api-client';
import {
  type WindowMemorySample,
  composeWindowMemorySample,
  freshWindowMemory,
  selectWindowMemoryField,
  windowMemoryExpiryDelayMs,
} from '@vibeterm/stores';
import type { TmuxState } from '@vibeterm/stores/tmux-state';
import { cn } from '@vibeterm/ui';
import { MemoryStick } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNodeTmuxStore, useTmuxSlice } from './tmux-slice';
import { isWindowMemorySampleStale } from './window-memory-staleness';

export type WindowMemoryTone = 'ok' | 'warn' | 'blocked' | 'stale';

/** 到软限额的这个比例就转黄：再往上内核就要开始限速回收了。 */
const WARN_RATIO = 0.75;

const TONE_CHIP_CLASS: Record<WindowMemoryTone, string> = {
  ok: TONE_CLASS.badge.ok,
  warn: TONE_CLASS.chip.warn,
  blocked: TONE_CLASS.chip.blocked,
  stale: TONE_CLASS.badge.muted,
};

/** 未设限（cgroup 值为 `max`）在 wire 上是 0。 */
const UNLIMITED = '∞';

/**
 * 到达时就已过期的读数（网关重放的旧缓存）。参照时刻取「本地收到」与「现在」中较晚的一个：
 * 徽标的时钟只在过期时醒，拿挂载时的 `now` 比新帧会把新帧算得比实际更新，反之不会误判。
 */
export function isWindowMemoryBadgeStale(sample: WindowMemorySample, now: number): boolean {
  return isWindowMemorySampleStale({
    sampledAt: sample.sampledAt,
    now: Math.max(now, sample.receivedAt),
  });
}

export function windowMemoryTone(sample: WindowMemorySample, stale = false): WindowMemoryTone {
  if (stale) return 'stale';
  // 粘性 OOM 标记压过一切：现在用量低不代表这个窗口没被杀过。
  if (sample.oomFlag) return 'blocked';
  // RSS 兜底的宿主根本没有 scope，也就没有阈值可比——再大的用量也不该变色。
  if (sample.source === 'rss') return 'ok';
  if (sample.high <= 0) return 'ok';
  if (sample.current >= sample.high) return 'blocked';
  return sample.current >= sample.high * WARN_RATIO ? 'warn' : 'ok';
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function formatLimit(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes) : UNLIMITED;
}

function limitLines(t: Translate, sample: WindowMemorySample): string[] {
  // RSS 兜底时限额三行全是 0，照 `formatLimit` 会打成「∞（未设限）」，把「限不了」说成「没限」。
  if (sample.source === 'rss') {
    return [t('window.memoryLimitUnavailable'), t('window.memorySourceRss')];
  }
  return [
    `${t('window.memoryLimitHigh')}: ${formatLimit(sample.high)}`,
    `${t('window.memoryLimitMax')}: ${formatLimit(sample.max)}`,
    `${t('window.memorySwapMax')}: ${formatLimit(sample.swapMax)}`,
  ];
}

/** 过期读数的采样时刻，按相对时间说（「3 天前」），浏览器与网关的时钟差在这里无关紧要。 */
function staleLine(t: Translate, sample: WindowMemorySample, now: number): string {
  const ago = formatRelative(t, sample.sampledAt, now, 'settings.share.time') ?? '';
  return t('window.memoryStale', { ago });
}

export function windowMemoryTooltipLines(
  t: Translate,
  sample: WindowMemorySample,
  stale: { now: number } | null = null
): string[] {
  const lines = [
    `${t('window.memory')}: ${formatBytes(sample.current)}`,
    ...(stale ? [staleLine(t, sample, stale.now)] : limitLines(t, sample)),
  ];
  // 粘性标记还在、计数器却随 scope 重建清零时，至少发生过一次——写 0 次会把结论说反。
  if (sample.oomFlag || sample.oomKills > 0) {
    lines.push(t('window.memoryOom', { count: Math.max(sample.oomKills, 1) }));
  }
  return lines;
}

/**
 * 徽标读时间的唯一入口：**不做周期性 tick**。过期时刻由这一帧的到达时刻（本地盖章）算得出来，
 * 只在那一刻醒一次；新样本带来新的 `receivedAt`，定时器随之重排。
 */
function useWindowMemoryClock(receivedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const delay = windowMemoryExpiryDelayMs(receivedAt, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [receivedAt]);

  return now;
}

/** 逐字段订阅：网关每 30 s 重发一帧心跳，整对象订阅会让徽标每帧空转。 */
function useWindowMemorySample(
  nodeId: string,
  deviceId: string | undefined,
  windowId: string | undefined
): WindowMemorySample | null {
  const store = useNodeTmuxStore(nodeId);
  const read =
    <K extends keyof WindowMemorySample>(key: K) =>
    (state: TmuxState) =>
      selectWindowMemoryField(state.windowMemory, deviceId, windowId, key);
  const current = useTmuxSlice(store, read('current'));
  const high = useTmuxSlice(store, read('high'));
  const max = useTmuxSlice(store, read('max'));
  const swapMax = useTmuxSlice(store, read('swapMax'));
  const oomKills = useTmuxSlice(store, read('oomKills'));
  const oomFlag = useTmuxSlice(store, read('oomFlag'));
  const panes = useTmuxSlice(store, read('panes'));
  const sampledAt = useTmuxSlice(store, read('sampledAt'));
  const receivedAt = useTmuxSlice(store, read('receivedAt'));
  const source = useTmuxSlice(store, read('source'));
  return useMemo(
    () =>
      composeWindowMemorySample({
        current,
        high,
        max,
        swapMax,
        oomKills,
        oomFlag,
        panes,
        sampledAt,
        receivedAt,
        source,
      }),
    [current, high, max, swapMax, oomKills, oomFlag, panes, sampledAt, receivedAt, source]
  );
}

export interface WindowMemoryBadgeProps {
  nodeId: string;
  /** 当前设备与路由选中的窗口；任一缺席就没有可展示的读数。 */
  deviceId?: string;
  windowId?: string;
}

export function WindowMemoryBadge({ nodeId, deviceId, windowId }: WindowMemoryBadgeProps) {
  const { t } = useTranslation();
  const sample = useWindowMemorySample(nodeId, deviceId, windowId);
  const now = useWindowMemoryClock(sample?.receivedAt ?? null);
  const fresh = freshWindowMemory(sample, now);
  if (!fresh) return null;

  const stale = isWindowMemoryBadgeStale(fresh, now);
  const tone = windowMemoryTone(fresh, stale);
  const lines = windowMemoryTooltipLines(
    t,
    fresh,
    stale ? { now: Math.max(now, fresh.receivedAt) } : null
  );
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none',
        TONE_CHIP_CLASS[tone]
      )}
      data-testid="window-memory-badge"
      data-tone={tone}
      data-stale={stale ? 'true' : undefined}
      title={lines.join('\n')}
      aria-label={lines.join(' · ')}
    >
      <MemoryStick className="h-3 w-3 shrink-0" />
      <span className="truncate">{formatBytes(fresh.current)}</span>
      {fresh.oomFlag && !stale && (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_CLASS.dot.blocked)}
          data-testid="window-memory-oom-dot"
        />
      )}
    </span>
  );
}
