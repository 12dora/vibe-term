// 节点详情里的直连插件：装 / 删各一次动作，两态共用同一枚按钮。
//
// 「装没装」只能问那台机器自己（`GET /api/local/status` 的 `direct`），不能拿列表里的
// `direct_capable` 反推——后者是**运行时**有没有加载上原生模块，装好但还没重启的机器它照样是
// false，删掉但还没重启的机器它照样是 true。装与删都只动磁盘与 env，运行中的 RTC 管理器无法
// 热加载，后端恒返回 `restartRequired: true`，所以每次动作之后都要给出「立即重启」。
//
// 本机走无前缀路径，远端节点经 `/n/<id>` 转发到那台机器上的同一组端点。

import type { NodeRow } from '@/node/mesh-nodes';
import { LocalApi, LocalApiError } from '@vibeterm/api-client/local/local-api';
import type { LocalDirectResponse, LocalDirectStatus } from '@vibeterm/api-client/local/types';
import { sleepOrAbort } from '@vibeterm/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeDirectError } from '../direct-section';
import { type Translate, nodeDetailClient } from './node-detail-types';

/** 这一枚按钮只发这两个动作：`enable` / `disable` 不删文件，不是「删除插件」的语义。 */
export type DirectPluginAction = 'install' | 'remove';

export type DirectPluginState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: LocalDirectStatus }
  /** 老节点没有 `/api/local/status`：入口转发回 404 / 405。 */
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string };

const UNSUPPORTED_STATUS = new Set([404, 405]);

/** 转发层自己的失败：目标节点没登录 / 打不通，与插件本身无关。 */
const CHANNEL_ERROR_KEY: Record<string, string> = {
  NODE_UNREACHABLE: 'nodes.detail.directUnreachable',
  NODE_LOGIN_REQUIRED: 'nodes.detail.directLoginRequired',
};

export interface NodeDirectIo {
  loadDirect(row: NodeRow): Promise<LocalDirectStatus>;
  setDirect(row: NodeRow, action: DirectPluginAction): Promise<LocalDirectResponse>;
  restart(row: NodeRow): Promise<void>;
}

export function createNodeDirectIo(): NodeDirectIo {
  const api = (row: NodeRow) => new LocalApi(nodeDetailClient(row));
  return {
    loadDirect: async (row) => (await api(row).status()).direct,
    setDirect: (row, action) => api(row).setDirect(action),
    restart: async (row) => {
      const res = await nodeDetailClient(row).fetch('/api/settings/restart', { method: 'POST' });
      if (!res.ok) throw new LocalApiError('restart_failed', `HTTP ${res.status}`, res.status);
    },
  };
}

export function directErrorCode(error: unknown): string | null {
  if (error instanceof LocalApiError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** 通道失败说人话，插件自身的失败沿用本机卡那份错误表（下载失败 / 平台不支持 / …）。 */
export function directPluginErrorText(t: Translate, error: unknown): string {
  const key = CHANNEL_ERROR_KEY[directErrorCode(error) ?? ''];
  return key ? t(key) : describeDirectError(t, error);
}

export function directStateFromError(err: unknown, t: Translate): DirectPluginState {
  const status = (err as { status?: number }).status;
  if (status !== undefined && UNSUPPORTED_STATUS.has(status)) return { kind: 'unsupported' };
  return { kind: 'failed', message: directPluginErrorText(t, err) };
}

export async function loadDirectPluginState(
  row: NodeRow,
  io: Pick<NodeDirectIo, 'loadDirect'>,
  t: Translate
): Promise<DirectPluginState> {
  try {
    return { kind: 'ready', status: await io.loadDirect(row) };
  } catch (err) {
    return directStateFromError(err, t);
  }
}

export const DIRECT_RESTART_DELAY_MS = 2000;
export const DIRECT_RESTART_INTERVAL_MS = 2000;
export const DIRECT_RESTART_TIMEOUT_MS = 60_000;

/**
 * 重启窗口里「问不到」是正常态，不是失败：目标进程正在退出 / 还没监听，转发层回 503
 * `NODE_UNREACHABLE`，本机则是 fetch 直接抛（无 status），反代还可能回 502 / 504。
 * 只有目标真的答话了（含 404 老节点、401 要登录），这一轮等待才算有结论。
 */
export function isRestartPendingError(err: unknown): boolean {
  if (directErrorCode(err) === 'NODE_UNREACHABLE') return true;
  const status = (err as { status?: number }).status;
  if (status === undefined) return true;
  return status === 502 || status === 503 || status === 504;
}

export interface RestartWaitOptions {
  /** 首次探测前的静默期：POST 回来时进程往往还没开始退出，立刻问会读到旧进程。 */
  delayMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

/**
 * 等目标节点重启回来：拿同一个 `GET …/api/local/status` 当探针，第一次答话即结束。
 * 返回 `null` 表示超时——重启可能仍在进行，调用方据此把「立即重启」放回去而不是宣告失败。
 */
export async function waitForDirectRestart(
  row: NodeRow,
  io: Pick<NodeDirectIo, 'loadDirect'>,
  t: Translate,
  options: RestartWaitOptions = {}
): Promise<DirectPluginState | null> {
  const {
    delayMs = DIRECT_RESTART_DELAY_MS,
    intervalMs = DIRECT_RESTART_INTERVAL_MS,
    timeoutMs = DIRECT_RESTART_TIMEOUT_MS,
    now = Date.now,
    sleep = sleepOrAbort,
  } = options;
  const deadline = now() + timeoutMs;
  await sleep(delayMs);
  for (;;) {
    try {
      return { kind: 'ready', status: await io.loadDirect(row) };
    } catch (err) {
      if (!isRestartPendingError(err)) return directStateFromError(err, t);
    }
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** 动作回执就是权威状态：不用为了刷新一个布尔再问一次那台机器。 */
export function applyDirectResult(
  state: DirectPluginState,
  result: LocalDirectResponse
): DirectPluginState {
  if (state.kind !== 'ready') return state;
  return {
    kind: 'ready',
    status: {
      ...state.status,
      installed: result.installed,
      enabled: result.enabled,
      capable: result.capable,
    },
  };
}

export interface DirectPluginUi {
  load: DirectPluginState;
  /** 在途动作；安装要下载最多 60 s，期间按钮转圈且不受理第二次点击。 */
  pending: DirectPluginAction | null;
  confirmingRemove: boolean;
  /** 已落盘、等重启生效的那个动作。 */
  applied: DirectPluginAction | null;
  restarting: boolean;
  error: string | null;
}

export function initialDirectPluginUi(): DirectPluginUi {
  return {
    load: { kind: 'loading' },
    pending: null,
    confirmingRemove: false,
    applied: null,
    restarting: false,
    error: null,
  };
}

export interface DirectPluginButton {
  action: DirectPluginAction;
  labelKey: string;
  destructive: boolean;
  disabled: boolean;
}

/**
 * 一枚按钮的两态：装了就是「删除」，没装就是「安装」。读不到状态时按钮维持「安装」的样子
 * 但锁住——原因写在同一段的状态行里，禁用的按钮挂不住 tooltip。
 */
export function directPluginButton(ui: DirectPluginUi): DirectPluginButton {
  const installed = ui.load.kind === 'ready' && ui.load.status.installed;
  const usable =
    ui.load.kind === 'ready' &&
    ui.load.status.supported &&
    ui.pending === null &&
    !ui.confirmingRemove &&
    !ui.restarting;
  return {
    action: installed ? 'remove' : 'install',
    labelKey: installed ? 'nodes.detail.directRemove' : 'nodes.detail.directInstall',
    destructive: installed,
    disabled: !usable,
  };
}

/** 状态行：平台 · 装没装（带版本）· 运行中。读不到就只有一句原因。 */
export function directPluginStatusText(state: DirectPluginState, t: Translate): string {
  if (state.kind === 'loading') return t('nodes.detail.directLoading');
  if (state.kind === 'unsupported') return t('nodes.detail.directUnsupportedNode');
  if (state.kind === 'failed') return state.message;
  const { platform, supported, installed, version, capable } = state.status;
  const parts = [platform];
  if (!supported) parts.push(t('nodes.machine.directUnsupported'));
  else if (!installed) parts.push(t('nodes.machine.directNotInstalled'));
  else
    parts.push(
      version
        ? t('nodes.machine.directInstalledVersion', { version })
        : t('nodes.machine.directInstalled')
    );
  if (capable) parts.push(t('nodes.detail.directRunning'));
  return parts.filter(Boolean).join(' · ');
}

export interface DirectPluginNotice {
  text: string;
  /** 还没点重启时才给「立即重启」。 */
  restartable: boolean;
}

export function directPluginNotice(ui: DirectPluginUi, t: Translate): DirectPluginNotice | null {
  if (ui.restarting) return { text: t('nodes.detail.directRestarting'), restartable: false };
  if (ui.applied === null) return null;
  return {
    text: t(
      ui.applied === 'install'
        ? 'nodes.detail.directInstalledRestart'
        : 'nodes.detail.directRemovedRestart'
    ),
    restartable: true,
  };
}

export type DirectPluginIntent =
  /** 有在途动作 / 正在确认 / 正在重启：这一次点击不作数。 */
  { kind: 'ignore' } | { kind: 'confirm' } | { kind: 'run'; action: DirectPluginAction };

/** 删除是破坏性动作，先过二次确认；安装直接发。 */
export function directPluginIntent(
  ui: DirectPluginUi,
  action: DirectPluginAction
): DirectPluginIntent {
  if (ui.pending !== null || ui.confirmingRemove || ui.restarting) return { kind: 'ignore' };
  return action === 'remove' ? { kind: 'confirm' } : { kind: 'run', action };
}

export interface NodeDirectPluginHandle {
  ui: DirectPluginUi;
  /** `remove` 先弹确认，`install` 直接发。 */
  onAction: (action: DirectPluginAction) => void;
  confirmRemove: () => void;
  cancelRemove: () => void;
  restartNow: () => void;
}

export function useNodeDirectPlugin(
  row: NodeRow,
  open: boolean,
  io?: NodeDirectIo
): NodeDirectPluginHandle {
  const { t } = useTranslation();
  const [ui, setUi] = useState<DirectPluginUi>(initialDirectPluginUi);

  // 列表每次轮询都换一批 row 对象，io / t 也随宿主重渲染重建：收进 ref，加载效应才只认
  // 「哪一行、开没开」。`uiRef` 则用于事件回调里读当前锁态——判重不能写在 `setUi` 的
  // updater 里，那个函数在 StrictMode 下会被调两次。
  const latest = useRef({ row, io, t });
  latest.current = { row, io, t };
  const uiRef = useRef(ui);
  uiRef.current = ui;
  // 换行 / 关闭 / 卸载都递增：最长要等 60 s 的重启轮询据此判断自己还算不算数。
  const runRef = useRef(0);
  const rowId = row.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: rowId 是「换了一行」的显式触发器，行对象本身走 ref
  useEffect(() => {
    if (!open) return;
    runRef.current += 1;
    const run = runRef.current;
    const { row: target, io: injected, t: translate } = latest.current;
    setUi(initialDirectPluginUi());
    void loadDirectPluginState(target, injected ?? createNodeDirectIo(), translate).then((load) => {
      if (runRef.current === run) setUi((prev) => ({ ...prev, load }));
    });
    return () => {
      runRef.current += 1;
    };
  }, [open, rowId]);

  const run = useCallback(async (action: DirectPluginAction) => {
    const { row: target, io: injected, t: translate } = latest.current;
    const effective = injected ?? createNodeDirectIo();
    setUi((prev) => ({ ...prev, pending: action, error: null }));
    try {
      const result = await effective.setDirect(target, action);
      setUi((prev) => ({
        ...prev,
        pending: null,
        applied: action,
        load: applyDirectResult(prev.load, result),
      }));
    } catch (err) {
      setUi((prev) => ({
        ...prev,
        pending: null,
        error: directPluginErrorText(translate, err),
      }));
    }
  }, []);

  const onAction = useCallback(
    (action: DirectPluginAction) => {
      const intent = directPluginIntent(uiRef.current, action);
      if (intent.kind === 'ignore') return;
      if (intent.kind === 'confirm') {
        setUi((prev) => ({ ...prev, confirmingRemove: true }));
        return;
      }
      void run(intent.action);
    },
    [run]
  );

  const confirmRemove = useCallback(() => {
    if (!uiRef.current.confirmingRemove) return;
    setUi((prev) => ({ ...prev, confirmingRemove: false }));
    void run('remove');
  }, [run]);

  const cancelRemove = useCallback(() => {
    setUi((prev) => (prev.confirmingRemove ? { ...prev, confirmingRemove: false } : prev));
  }, []);

  /**
   * 「立即重启」。POST 回来只代表**已排程**，进程还没退；不接着等的话这一段会永远停在
   * 「正在重启……」。等回来就把状态重读一遍并撤掉提醒，超时则把「立即重启」放回去——
   * 重启可能仍在进行，宣告失败是错的。
   */
  const restartNow = useCallback(() => {
    const { row: target, io: injected, t: translate } = latest.current;
    const effective = injected ?? createNodeDirectIo();
    const run = runRef.current;
    const alive = () => runRef.current === run;
    const fail = (reason: string) =>
      setUi((prev) => ({
        ...prev,
        restarting: false,
        error: translate('nodes.detail.directRestartFailed', { error: reason }),
      }));

    setUi((prev) => ({ ...prev, restarting: true, error: null }));
    void (async () => {
      try {
        await effective.restart(target);
      } catch (err) {
        if (alive()) fail(directPluginErrorText(translate, err));
        return;
      }
      const load = await waitForDirectRestart(target, effective, translate);
      if (!alive()) return;
      if (load === null) {
        fail(translate('nodes.detail.directRestartTimeout'));
        return;
      }
      setUi((prev) => ({ ...prev, load, restarting: false, applied: null, error: null }));
    })();
  }, []);

  return { ui, onAction, confirmRemove, cancelRemove, restartNow };
}
