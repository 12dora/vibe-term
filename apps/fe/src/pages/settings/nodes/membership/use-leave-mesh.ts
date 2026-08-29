// 退出 mesh 的 React 接线：把 `runLeaveWorkflow` 需要的依赖（凭据签名、api、重启等待、
// 记号、硬跳转）一一喂进去，自己只保留阶段/文案状态与进入守卫。
//
// 编排本身（顺序、记号时机、鉴权切换标记、超时终态）在 `leave-controller.ts` 里，那里没有
// React、可以直接测。

import { beginAuthTransition, endAuthTransition } from '@/auth/auth-transition';
import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { LocalApiError } from '@tmex/api-client/local/local-api';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { readStartedAt, waitForRestart } from '../restart/wait-for-restart';
import { navigateToSettingsNodes, reloadPage } from '../setup/browser-location';
import { type IntentStorage, clearSetupIntent, writeSetupIntent } from './intent';
import { type LeaveApi, defaultLeaveApi } from './leave-api';
import {
  type InFlightGuard,
  type LeavePhase,
  type LeaveRequest,
  type LeaveRestartOutcome,
  awaitRestartAndNavigate,
  createInFlightGuard,
  runLeaveWorkflow,
} from './leave-controller';
import { selfRevokeNode } from './self-revoke';

export type { LeavePhase, LeaveRequest };

/** 没有 uid / kdf 参数时不会走到签名分支；hook 不能条件调用，给个不会被用到的占位。 */
const PLACEHOLDER_KDF: AuthKdfParamsJson = {
  salt: '',
  memory_kib: 0,
  iterations: 0,
  parallelism: 0,
};

const LEAVE_ERROR_KEY: Record<string, string> = {
  not_member: 'nodes.membership.errors.notMember',
  role_mismatch: 'nodes.membership.errors.roleMismatch',
  setup_in_progress: 'nodes.membership.errors.setupInProgress',
  env_write_failed: 'nodes.membership.errors.envWriteFailed',
  unauthorized: 'nodes.membership.errors.unauthorized',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function describeLeaveError(t: Translate, error: unknown): string {
  const base = t(
    (error instanceof LocalApiError && LEAVE_ERROR_KEY[error.code]) ||
      'nodes.membership.leaveFailed'
  );
  const detail = (error instanceof Error ? error.message : String(error)).trim();
  const code = error instanceof LocalApiError ? error.code : '';
  if (!detail || detail === code || LEAVE_ERROR_KEY[code]) return base;
  return t('nodes.membership.errorDetail', { base, detail });
}

export interface UseLeaveMeshOptions {
  mode: AuthModeResponse | null;
  client?: ApiClient;
  leaveApi?: LeaveApi;
  authApi?: AuthApi;
  /** 测试注入。 */
  storage?: IntentStorage | null;
  navigate?: () => void;
}

export interface LeaveMesh {
  phase: LeavePhase;
  busy: boolean;
  error: string | null;
  /** 自吊销没做成：不挡退出，只提示。 */
  warning: string | null;
  elapsedMs: number;
  run: (request: LeaveRequest) => void;
  reset: () => void;
  /** 重启等待超时后再查一次；**不会**重发 `leave`。 */
  recheck: () => void;
  /** 重启等待超时后整页刷新，让用户自己看当前状态。 */
  reload: () => void;
  /** 自吊销要签名，凭据对话框挂在调用方页面里。 */
  dialog: ReactElement | null;
}

export function useLeaveMesh(options: UseLeaveMeshOptions): LeaveMesh {
  const {
    mode,
    client = defaultApiClient,
    leaveApi = defaultLeaveApi,
    authApi = defaultAuthApi,
    storage,
    navigate = navigateToSettingsNodes,
  } = options;
  const { t } = useTranslation();
  const [phase, setPhase] = useState<LeavePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // 语义见 `createInFlightGuard`：抢不到就整个丢弃这次调用，连 state 都不许动
  // ——第二次点击若先把在途的 AbortController 换掉，第一条流程的重启等待会被就地掐死。
  const guardRef = useRef<InFlightGuard | null>(null);
  guardRef.current ??= createInFlightGuard();
  const guard = guardRef.current;
  const abortRef = useRef<AbortController | null>(null);
  const baselineRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    []
  );

  const uid = mode?.uid ?? null;
  const kdfParams = mode?.kdfParams ?? null;
  const rootEpoch = typeof mode?.rootEpoch === 'number' ? mode.rootEpoch : null;
  const nodeId = mode?.nodeId ?? null;
  const canRevoke = Boolean(uid && kdfParams && rootEpoch !== null && nodeId);

  const { passkeys } = usePasskeys(authApi, {
    enabled: canRevoke && Boolean(mode?.passkeyAvailable),
  });
  const prompt = useCredentialPrompt({
    kdfParams: kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(mode?.rootPublicKey),
    passkeys,
    passkeyAvailable: mode?.passkeyAvailable ?? false,
  });

  const { withSigner } = prompt;

  /** 每次等待换一个 AbortController：卸载与 reset 都要能立刻断掉在途的 `/healthz`。 */
  const newWait = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setElapsedMs(0);
    return controller;
  }, []);

  const wait = useCallback(
    (controller: AbortController, previousStartedAt: number | null): Promise<LeaveRestartOutcome> =>
      waitForRestart({
        previousStartedAt,
        fetchImpl: (path, init) => client.fetch(path, init),
        signal: controller.signal,
        onElapsed: (ms) => {
          if (!controller.signal.aborted) setElapsedMs(ms);
        },
      }),
    [client]
  );

  const run = useCallback(
    (request: LeaveRequest) => {
      if (!guard.tryEnter()) return;
      setError(null);
      setWarning(null);
      setElapsedMs(0);

      const controller = newWait();
      const fetchImpl = (path: string, init?: RequestInit) => client.fetch(path, init);

      void runLeaveWorkflow(
        {
          // hub 兼节点的机器就是自己的 hub，没有「向别人报备」这一说：只有纯 node 需要自吊销。
          revoke:
            request.from === 'node' && canRevoke && uid && rootEpoch !== null && nodeId
              ? () =>
                  selfRevokeNode({
                    api: authApi,
                    uid,
                    rootEpoch,
                    nodeIdHex: nodeId,
                    withSigner,
                  })
              : null,
          readStartedAt: () => readStartedAt(fetchImpl, undefined, controller.signal),
          leave: (body) => leaveApi.leave(body),
          waitForRestart: (previousStartedAt) => wait(controller, previousStartedAt),
          navigate,
          writeIntent: (intent) => writeSetupIntent(intent, storage),
          clearIntent: () => clearSetupIntent(storage),
          beginAuthTransition,
          endAuthTransition,
          setPhase: (next) => {
            if (!controller.signal.aborted) setPhase(next);
          },
          onRevokeOutcome: (outcome) => {
            const message =
              outcome.kind === 'failed'
                ? t('nodes.membership.revokeFailed', { error: outcome.reason })
                : t('nodes.membership.revokeSkipped');
            if (!controller.signal.aborted) setWarning(message);
            toast.warning(message);
          },
          onLeaveError: (err) => {
            const message = describeLeaveError(t, err);
            if (!controller.signal.aborted) setError(message);
            toast.error(message);
          },
          onBaseline: (startedAt) => {
            baselineRef.current = startedAt;
          },
          release: guard.release,
        },
        request
      );
    },
    [
      authApi,
      canRevoke,
      client,
      guard,
      leaveApi,
      navigate,
      newWait,
      nodeId,
      rootEpoch,
      storage,
      t,
      uid,
      wait,
      withSigner,
    ]
  );

  // 超时后的恢复动作：只重跑等待，绝不重发 `leave`——退出已经提交成功了。
  const recheck = useCallback(() => {
    const controller = newWait();
    void awaitRestartAndNavigate(
      {
        waitForRestart: (previousStartedAt) => wait(controller, previousStartedAt),
        navigate,
        setPhase: (next) => {
          if (!controller.signal.aborted) setPhase(next);
        },
      },
      baselineRef.current
    );
  }, [navigate, newWait, wait]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    guard.release();
    baselineRef.current = null;
    setPhase('idle');
    setError(null);
    setWarning(null);
    setElapsedMs(0);
  }, [guard]);

  return {
    phase,
    busy: phase === 'leaving' || phase === 'restarting',
    error,
    warning,
    elapsedMs,
    run,
    reset,
    recheck,
    reload: reloadPage,
    dialog: prompt.dialog,
  };
}
