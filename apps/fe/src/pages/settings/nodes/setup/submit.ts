// 向导的提交编排：先记下当前进程的 startedAt，再调 setup 端点。
//
// 顺序不能反——响应回来时网关可能已经在 300ms 后退出，那时再读 `/healthz` 拿到的
// 就是新进程的 startedAt，重启判定会永远等不到「变化」。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import { SetupApi, readHealthStartedAt } from '@tmex/api-client/local/setup-api';
import type {
  SetupHubResponse,
  SetupJoinResponse,
  SetupRelayJoinResponse,
  SetupRelayResponse,
} from '@tmex/api-client/local/types';
import {
  type BecomeHubValues,
  type BecomeRelayValues,
  type JoinHubValues,
  type JoinRelayValues,
  type NodeEnv,
  normalizeTenantId,
  normalizeToken,
} from './validation';

export interface SubmitOutcome<T> {
  /** 提交前记录的进程 startedAt，交给 `useRestartWaiter.start()`。 */
  previousStartedAt: number | null;
  result: T;
}

export async function submitBecomeHub(
  values: BecomeHubValues,
  client: ApiClient = defaultApiClient
): Promise<SubmitOutcome<SetupHubResponse>> {
  const previousStartedAt = await readHealthStartedAt(client);
  const result = await new SetupApi(client).becomeHub({
    hubPublicUrl: values.hubPublicUrl.trim(),
    username: values.username.trim(),
    password: values.password,
    directEnable: values.directEnable,
  });
  return { previousStartedAt, result };
}

export async function submitJoinHub(
  values: JoinHubValues,
  nodeEnv: NodeEnv,
  client: ApiClient = defaultApiClient
): Promise<SubmitOutcome<SetupJoinResponse>> {
  const previousStartedAt = await readHealthStartedAt(client);
  const result = await new SetupApi(client).joinHub({
    hubUrl: values.hubUrl.trim(),
    method: values.method,
    // 两者互斥：后端见到同时带 token 与 password 会直接 400，只发当前方式那一个。
    ...(values.method === 'password'
      ? { password: values.password }
      : { token: normalizeToken(values.token) }),
    name: values.name.trim(),
    directEnable: values.directEnable,
    // production 下后端会忽略该字段，索性不发，避免日志里出现误导性的 true。
    ...(nodeEnv === 'production' ? {} : { insecureLocal: values.insecureLocal }),
  });
  return { previousStartedAt, result };
}

export async function submitJoinRelay(
  values: JoinRelayValues,
  client: ApiClient = defaultApiClient
): Promise<SubmitOutcome<SetupRelayJoinResponse>> {
  const previousStartedAt = await readHealthStartedAt(client);
  const caFingerprint = values.caFingerprint.trim().toLowerCase();
  const result = await new SetupApi(client).relayJoin({
    relayUrl: values.relayUrl.trim(),
    tenantId: normalizeTenantId(values.tenantId),
    password: values.password,
    name: values.name.trim(),
    ...(caFingerprint ? { caFingerprint } : {}),
    directEnable: values.directEnable,
  });
  return { previousStartedAt, result };
}

export async function submitBecomeRelay(
  values: BecomeRelayValues,
  client: ApiClient = defaultApiClient
): Promise<SubmitOutcome<SetupRelayResponse>> {
  const previousStartedAt = await readHealthStartedAt(client);
  const password = values.relayPassword.trim();
  const result = await new SetupApi(client).setupRelay({
    role: values.alsoNode ? 'relay,node' : 'relay',
    relayPublicUrl: values.relayPublicUrl.trim(),
    // 空串是「不设口令」，与「没填这个字段」是同一件事：统一发 null，别让后端猜。
    relayPassword: password === '' ? null : password,
    ...(values.alsoNode
      ? {
          username: values.username.trim(),
          password: values.password,
          directEnable: values.directEnable,
        }
      : {}),
  });
  return { previousStartedAt, result };
}
