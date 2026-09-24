// 「设置已是不限制，窗口却还显示限额」的提示。
//
// `/api/sessions/memory` 里的读数可能是采样停摆前留下的（几天前的 8 GB / 12 GB）：过期的读数
// 不能当成「仍带限额」的证据，只能说「读数过期、确认不了」；还新鲜的读数才说「仍带限额」。
// 网关标了 `stale` 的窗口不管读数里有没有限额都算「确认不了」：老一点的网关会把过期窗口的
// 限额清成 0，而 0 在契约里是「未设限」，照读就成了「已放开」。
// 只对照打开表单时读到的那份记录——刚保存完网关还没来得及放开，这时报「仍带限额」是误报。

import { formatRelative } from '@/lib/format-relative';
import { isWindowMemorySampleStale } from '@/node/window-memory-staleness';
import type { SessionsMemoryResponse, SessionsMemoryWindow } from '@vibeterm/api-client';
import type { WindowMemorySettings } from '@vibeterm/shared';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { isUnlimitedSettings } from './memory-limits-form';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 提示里最多点名几个窗口；再多只给总数。 */
const NAMED_WINDOWS = 5;

export interface MemoryLimitsReleaseReport {
  /** 读数新鲜、仍带限额的窗口（「设备 / 窗口」）。 */
  lingering: string[];
  /** 带限额但读数已过期的窗口数与其中最早的采样时刻。 */
  stale: { count: number; oldestSampledAt: number } | null;
}

function hasLimit(window: SessionsMemoryWindow): boolean {
  return window.high > 0 || window.max > 0 || window.swapMax > 0;
}

/** 可选字段按 unknown 读：api-client 的规范化未必认得这些新字段。 */
function optionalField(window: SessionsMemoryWindow, key: 'stale' | 'sampledAgeMs'): unknown {
  return (window as unknown as Record<string, unknown>)[key];
}

/** 采样时刻折算到浏览器时钟：网关给了读数年龄就按它倒推，不拿节点时钟当浏览器时钟用。 */
function localSampledAt(window: SessionsMemoryWindow, now: number): number {
  const age = optionalField(window, 'sampledAgeMs');
  return typeof age === 'number' && Number.isFinite(age) && age >= 0 ? now - age : window.sampledAt;
}

type WindowVerdict = 'none' | 'lingering' | 'stale';

/** 一个窗口该怎么说：读数新鲜且带限额 → 仍带限额；过期（或网关标了 stale）→ 确认不了。 */
function windowVerdict(
  window: SessionsMemoryWindow,
  connected: boolean,
  settings: WindowMemorySettings,
  now: number
): WindowVerdict {
  if (window.source === 'rss') return 'none';
  const flagged = optionalField(window, 'stale') === true;
  if (!flagged && !hasLimit(window)) return 'none';
  const stale = isWindowMemorySampleStale({
    sampledAt: window.sampledAt,
    now,
    intervalSec: settings.sampleIntervalSec,
    stale: flagged,
    sampledAgeMs: optionalField(window, 'sampledAgeMs'),
    connected,
  });
  return stale ? 'stale' : 'lingering';
}

/** 设置不是「不限制」、或没有任何带限额的窗口时返回 `null`：没什么要说的。 */
export function memoryLimitsReleaseReport(
  response: SessionsMemoryResponse | null,
  settings: WindowMemorySettings | null,
  now: number
): MemoryLimitsReleaseReport | null {
  if (!response || !settings || !isUnlimitedSettings(settings)) return null;
  const lingering: string[] = [];
  let staleCount = 0;
  let oldestSampledAt = Number.POSITIVE_INFINITY;
  for (const device of response.devices) {
    for (const window of device.windows) {
      const verdict = windowVerdict(window, device.connected, settings, now);
      if (verdict === 'stale') {
        staleCount += 1;
        oldestSampledAt = Math.min(oldestSampledAt, localSampledAt(window, now));
      } else if (verdict === 'lingering') {
        lingering.push(`${device.deviceName} / ${window.windowName || window.windowId}`);
      }
    }
  }
  if (lingering.length === 0 && staleCount === 0) return null;
  return {
    lingering,
    stale: staleCount > 0 ? { count: staleCount, oldestSampledAt } : null,
  };
}

function namedWindows(names: string[]): string {
  const shown = names.slice(0, NAMED_WINDOWS).join('、');
  return names.length > NAMED_WINDOWS ? `${shown}…` : shown;
}

export function memoryLimitsReleaseLines(
  t: Translate,
  report: MemoryLimitsReleaseReport,
  now: number
): { lingering: string | null; stale: string | null } {
  const lingering =
    report.lingering.length > 0
      ? t('settings.nodes.memory.notReleased', {
          count: report.lingering.length,
          windows: namedWindows(report.lingering),
        })
      : null;
  const stale = report.stale
    ? t('settings.nodes.memory.staleSample', {
        count: report.stale.count,
        ago:
          formatRelative(t, report.stale.oldestSampledAt, now, 'settings.share.time') ??
          t('settings.share.time.justNow'),
      })
    : null;
  return { lingering, stale };
}

export function MemoryLimitsReleaseNotice({
  report,
  now,
  testId,
}: {
  report: MemoryLimitsReleaseReport | null;
  now: number;
  testId: string;
}) {
  const { t } = useTranslation();
  if (!report) return null;
  const lines = memoryLimitsReleaseLines(t, report, now);
  return (
    <>
      {lines.lingering && (
        <Notice tone="warning" testId={`${testId}-lingering`}>
          <p>{lines.lingering}</p>
        </Notice>
      )}
      {lines.stale && (
        <Notice tone="info" testId={`${testId}-stale`}>
          <p>{lines.stale}</p>
        </Notice>
      )}
    </>
  );
}
