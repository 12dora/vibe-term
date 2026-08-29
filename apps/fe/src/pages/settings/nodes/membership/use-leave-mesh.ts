// 退出 mesh 的编排：自吊销（尽力而为）→ `POST /api/local/leave` → 等重启 → 整页跳回设置页。
//
// 顺序上先读 `/healthz.startedAt` 再调 leave：响应回来时网关可能已经在 300 ms 后退出，
// 那时再读到的就是新进程的 startedAt，重启判定会永远等不到「变化」（与向导 `submit.ts` 同理）。
//
// 退出会把本机的 mesh 状态（账号、node 身份、缓存的 peer）全部删掉并重启，
// 鉴权模式随之从 mesh 变回 standalone——所以最后必须整页跳转，不能走 react-router。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { LocalApiError } from '@tmex/api-client/local/local-api';
import { readHealthStartedAt } from '@tmex/api-client/local/setup-api';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useRestartNow } from '../restart/use-restart-now';
import { navigateToSettingsNodes } from '../setup/browser-location';
import { type IntentStorage, type SetupIntent, clearSetupIntent, writeSetupIntent } from './intent';
import { type LeaveApi, defaultLeaveApi } from './leave-api';
import type { MeshRole } from './role-transition';
import { selfRevokeNode } from './self-revoke';

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

export type LeavePhase = 'idle' | 'leaving' | 'restarting' | 'restarted' | 'timeout' | 'error';

export interface LeaveRequest {
  /** 当前角色，作为 `expectedRole` 发给后端做一致性校验。 */
  from: MeshRole;
  /** 重启回 standalone 后要展开的向导路径；纯粹退出时为 null。 */
  intent: SetupIntent | null;
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

  const restart = useRestartNow({ client, onRestarted: navigate });
  const restartState = restart.state;
  useEffect(() => {
    if (restartState === 'waiting') setPhase('restarting');
    else if (restartState === 'restarted') setPhase('restarted');
    else if (restartState === 'timeout') setPhase('timeout');
  }, [restartState]);

  const { start } = restart;
  const { withSigner } = prompt;

  const run = useCallback(
    (request: LeaveRequest) => {
      void (async () => {
        setError(null);
        setWarning(null);
        setPhase('leaving');
        if (request.intent) writeSetupIntent(request.intent, storage);
        else clearSetupIntent(storage);

        const previousStartedAt = await readHealthStartedAt(client);

        // hub 兼节点的机器就是自己的 hub，没有「向别人报备」这一说：只有纯 node 需要自吊销。
        if (request.from === 'node' && canRevoke && uid && rootEpoch !== null && nodeId) {
          const outcome = await selfRevokeNode({
            api: authApi,
            uid,
            rootEpoch,
            nodeIdHex: nodeId,
            withSigner,
          });
          if (outcome.kind === 'failed') {
            const message = t('nodes.membership.revokeFailed', { error: outcome.reason });
            setWarning(message);
            toast.warning(message);
          } else if (outcome.kind === 'cancelled') {
            const message = t('nodes.membership.revokeSkipped');
            setWarning(message);
            toast.warning(message);
          }
        }

        try {
          await leaveApi.leave({ expectedRole: request.from });
        } catch (err) {
          const message = describeLeaveError(t, err);
          setError(message);
          setPhase('error');
          toast.error(message);
          return;
        }
        setPhase('restarting');
        start(previousStartedAt);
      })();
    },
    [authApi, canRevoke, client, leaveApi, nodeId, rootEpoch, start, storage, t, uid, withSigner]
  );

  const { cancel } = restart;
  const reset = useCallback(() => {
    cancel();
    setPhase('idle');
    setError(null);
    setWarning(null);
  }, [cancel]);

  return {
    phase,
    busy: phase === 'leaving' || phase === 'restarting',
    error,
    warning,
    elapsedMs: restart.elapsedMs,
    run,
    reset,
    dialog: prompt.dialog,
  };
}
