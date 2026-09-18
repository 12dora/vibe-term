// 远程内存限额：把本机卡那份「窗口内存限额」表单开到节点管理表上。
//
// 通道是目标节点自己的 `GET/PUT /api/settings/window-memory`，经 `/n/<id>` 前缀转发
// （与详情框的域名访问同一条路），不是入口的 mesh 管理 API。
//
// 转发器对 `/api/settings/*` 用 `purpose: 'user'` 取链路，已暂停的节点会被闸成
// `NODE_UNREACHABLE`；这里不绕开这条语义，而是把「已暂停」当成跳过原因摆给用户看。

import type { NodeRow } from '@/node/mesh-nodes';
import {
  type ApiClient,
  ApiError,
  type SessionsMemoryResponse,
  createNodeApiClient,
  devicesWithoutMemoryLimits,
  getSessionsMemory,
  getWindowMemorySettings,
  isNodeLoginRequiredError,
  isNodeUnreachableError,
  putWindowMemorySettings,
} from '@vibeterm/api-client';
import { type WindowMemorySettings, compareSemver } from '@vibeterm/shared';
import {
  type MemoryLimitsDraft,
  type MemoryLimitsErrors,
  memoryLimitsDraft,
  submitMemoryLimits,
} from '../memory-limits-form';
import { actionErrorText } from './errors';
import type { Translate } from './node-detail-types';

/** 首个带 `GET/PUT /api/settings/window-memory` 的网关版本；更早的节点上这个端点不存在。 */
export const MIN_WINDOW_MEMORY_SETTINGS_VERSION = '2.7.0';

/** 老节点没有这个端点：入口原样转发目标的 404 / 405。 */
const UNSUPPORTED_STATUS = new Set([404, 405]);

/** 批量写入的并发上限：PUT 很轻，压这么几台只是为了别把转发器排满。 */
export const MEMORY_LIMITS_CONCURRENCY = 3;

/** 一台节点不能改内存限额的原因；`null` 表示可以改。 */
export type MemoryLimitsSkipReason = 'tooOld' | 'offline' | 'loginRequired' | 'paused';

export interface MemoryLimitsPlan {
  targets: NodeRow[];
  skipped: Array<{ row: NodeRow; reason: MemoryLimitsSkipReason }>;
}

/** 版本能解析且低于 `MIN_WINDOW_MEMORY_SETTINGS_VERSION`。无法解析的版本不算，交给后端裁决。 */
export function isTooOldForWindowMemorySettings(version: string | null): boolean {
  if (!version) return false;
  return compareSemver(version, MIN_WINDOW_MEMORY_SETTINGS_VERSION) === -1;
}

/**
 * 本机走无前缀客户端，转发器的三道闸（在线 / 会话 cookie / 暂停）都不适用，只剩版本一条。
 * 其余节点按转发器实际会卡住的顺序判：离线 → 未登录 → 已暂停。
 */
export function memoryLimitsSkipReason(
  row: Pick<NodeRow, 'isSelf' | 'online' | 'loggedIn' | 'version' | 'paused'>
): MemoryLimitsSkipReason | null {
  if (isTooOldForWindowMemorySettings(row.version ?? null)) return 'tooOld';
  if (row.isSelf) return null;
  if (!row.online) return 'offline';
  if (!row.loggedIn) return 'loginRequired';
  if (row.paused === true) return 'paused';
  return null;
}

/** 把选中的行分拣成「能写」与「跳过 + 原因」，批量确认框据此把话说清楚。 */
export function planMemoryLimits(rows: NodeRow[]): MemoryLimitsPlan {
  const plan: MemoryLimitsPlan = { targets: [], skipped: [] };
  for (const row of rows) {
    const reason = memoryLimitsSkipReason(row);
    if (reason) plan.skipped.push({ row, reason });
    else plan.targets.push(row);
  }
  return plan;
}

/** 目标节点的 REST 客户端：本机退化成无前缀，远端走 `/n/<id>`。 */
export function memoryLimitsClient(row: Pick<NodeRow, 'runtimeNodeId'>): ApiClient {
  return createNodeApiClient(row.runtimeNodeId);
}

/** 状态机与真实请求之间的接缝：单测注入假 IO，不碰网络。 */
export interface MemoryLimitsIo {
  get(row: NodeRow): Promise<WindowMemorySettings>;
  put(row: NodeRow, settings: WindowMemorySettings): Promise<WindowMemorySettings>;
  /** 目标节点的窗口内存读数；只用来判断限额会不会生效，缺省即不提示。 */
  sessions?(row: NodeRow): Promise<SessionsMemoryResponse>;
}

export const defaultMemoryLimitsIo: MemoryLimitsIo = {
  get: (row) => getWindowMemorySettings(memoryLimitsClient(row)),
  put: (row, settings) => putWindowMemorySettings(settings, memoryLimitsClient(row)),
  sessions: (row) => getSessionsMemory(memoryLimitsClient(row)),
};

/**
 * 目标节点上「限额写得进设置、却落不到 cgroup」的设备名。
 * 宿主没有 pane scope（tmux < 3.6 / 没带 systemd 支持）时 `limitsSupported` 为 false；
 * `null` 是尚未判定，不算进来。
 */
export function memoryLimitsUnsupportedDevices(response: SessionsMemoryResponse): string[] {
  return devicesWithoutMemoryLimits(response).map((device) => device.deviceName);
}

/**
 * 这条通道的失败文案。转发器自己的失败回的是顶层信封（`NODE_UNREACHABLE` /
 * `NODE_LOGIN_REQUIRED`），照原样显示只是一串大写代号；老节点则是一个裸 404。
 */
export function memoryLimitsErrorText(t: Translate, err: unknown): string {
  if (isNodeUnreachableError(err)) return t('nodes.memory.errors.unreachable');
  if (isNodeLoginRequiredError(err)) return t('nodes.memory.errors.loginRequired');
  if (err instanceof ApiError) {
    if (UNSUPPORTED_STATUS.has(err.status)) return t('nodes.memory.errors.unsupported');
    return err.message;
  }
  return actionErrorText(t, err);
}

/** 一台写失败的节点。`id` 是必需的：节点名可以重复，两台都叫「工作室」时只有 id 分得清。 */
export interface MemoryLimitsFailure {
  id: string;
  name: string;
  message: string;
}

export interface MemoryLimitsBatchSummary {
  saved: number;
  failed: MemoryLimitsFailure[];
}

export interface MemoryLimitsBatchParams {
  targets: NodeRow[];
  settings: WindowMemorySettings;
  io: MemoryLimitsIo;
  t: Translate;
  concurrency?: number;
  /** 每台落定时回调一次；批量期间行上没有进度条，这里只给调用方留个钩子。 */
  onSettled?: (row: NodeRow, error: string | null) => void;
}

/**
 * 逐台 PUT 同一份限额，并发上限 `MEMORY_LIMITS_CONCURRENCY`。一台失败不影响其余几台，
 * 失败清单按**输入顺序**收集——并发下的完成次序会让汇总文案时好时坏。
 */
export async function runMemoryLimitsBatch(
  p: MemoryLimitsBatchParams
): Promise<MemoryLimitsBatchSummary> {
  const failures = new Array<string | null>(p.targets.length).fill(null);
  let next = 0;
  const limit = Math.min(p.concurrency ?? MEMORY_LIMITS_CONCURRENCY, p.targets.length);

  const worker = async () => {
    for (;;) {
      const index = next++;
      const row = p.targets[index];
      if (!row) return;
      let message: string | null = null;
      try {
        await p.io.put(row, p.settings);
      } catch (err) {
        message = memoryLimitsErrorText(p.t, err);
      }
      failures[index] = message;
      p.onSettled?.(row, message);
    }
  };
  // allSettled：任何一条 worker 意外抛出都不能中断兄弟 worker。
  await Promise.allSettled(Array.from({ length: limit }, worker));

  const summary: MemoryLimitsBatchSummary = { saved: 0, failed: [] };
  p.targets.forEach((row, index) => {
    const message = failures[index];
    if (message === null) summary.saved += 1;
    else summary.failed.push({ id: row.id, name: row.name, message });
  });
  return summary;
}

export interface MemoryLimitsFailureLabel {
  id: string;
  label: string;
  message: string;
}

/** 失败清单的显示名：重名的节点各自补上 id 前 8 位，否则两条「工作室」分不出是哪台。 */
export function memoryLimitsFailureLabels(
  t: Translate,
  failed: readonly MemoryLimitsFailure[]
): MemoryLimitsFailureLabel[] {
  const seen = new Map<string, number>();
  for (const item of failed) seen.set(item.name, (seen.get(item.name) ?? 0) + 1);
  return failed.map((item) => ({
    id: item.id,
    message: item.message,
    label:
      (seen.get(item.name) ?? 0) > 1
        ? t('nodes.memory.failedNameWithId', { name: item.name, id: item.id.slice(0, 8) })
        : item.name,
  }));
}

/** 汇总提示的文案与档次；提示本身由调用方发出，方便单测只看文案。 */
export function memoryLimitsSummaryText(
  t: Translate,
  summary: MemoryLimitsBatchSummary
): { level: 'success' | 'error'; text: string } {
  if (summary.failed.length === 0) {
    return { level: 'success', text: t('nodes.memory.summary', { count: summary.saved }) };
  }
  return {
    level: 'error',
    text: t('nodes.memory.summaryFailed', {
      count: summary.saved,
      failed: summary.failed.length,
      names: memoryLimitsFailureLabels(t, summary.failed)
        .map((item) => item.label)
        .join('、'),
    }),
  };
}

export interface MemoryLimitsSaveParams {
  draft: MemoryLimitsDraft;
  put: (settings: WindowMemorySettings) => Promise<WindowMemorySettings>;
  t: Translate;
  /** 对话框是否还挂着。请求发出后组件可能已卸载，那之后一律不写 state、不弹提示。 */
  alive: () => boolean;
  setSaving: (saving: boolean) => void;
  setErrors: (errors: MemoryLimitsErrors) => void;
  setDraft: (draft: MemoryLimitsDraft) => void;
  onSaved: () => void;
  notify: (level: 'success' | 'error', text: string) => void;
}

/** 单台节点的保存回路。抽成纯函数：卸载后的静默由单测直接盯，不必起 DOM。 */
export async function runMemoryLimitsSave(p: MemoryLimitsSaveParams): Promise<void> {
  p.setSaving(true);
  const result = await submitMemoryLimits(p.draft, async (settings) => {
    try {
      return await p.put(settings);
    } catch (err) {
      // 转发器的信封在这里换成人话；`submitMemoryLimits` 只认 message。
      throw new Error(memoryLimitsErrorText(p.t, err));
    }
  });
  if (!p.alive()) return;
  p.setErrors(result.errors);
  p.setSaving(false);
  if (result.saved) {
    p.setDraft(memoryLimitsDraft(result.saved));
    p.notify('success', p.t('settings.nodes.memory.saved'));
    p.onSaved();
    return;
  }
  if (result.failure) {
    p.notify('error', p.t('settings.nodes.memory.saveFailed', { message: result.failure }));
  }
}
