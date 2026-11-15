// 登录时的 PoP 绑定（懒加载，随 `session-login` 一起进登录 chunk，不进常驻路径）。
//
// 先把这把钥落盘并占住（`lease`），登录成功才把 node 绑到它上面；失败只放掉占用，
// 其它 node 的钥与绑定一动不动，这把没人引用的新钥随之回收。

import type { AuthApi, AuthLoginRequest, LoginResult } from '@vibeterm/api-client/auth/index';
import type { SessionKeySecrets } from './session-key-types';
import {
  POP_SESSION_HARD_TTL_MS,
  dropUnusedKeys,
  loadPopState,
  notifyPopNodes,
  persistPopState,
  popEpoch,
  popKeys,
  popNodes,
} from './session-pop-client';

/** `popKeys` 的下标：公钥的小写十六进制。 */
export function popKeyId(sessPk: Uint8Array): string {
  return Array.from(sessPk, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface PopLease {
  id: string;
  epoch: number;
}

function release(lease: PopLease): void {
  const entry = popKeys.get(lease.id);
  if (entry) entry.leases -= 1;
  if (dropUnusedKeys()) void persistPopState();
}

/** 占住这把钥并保证它已落盘；回退钥 / 无 IndexedDB / 写失败返回 null（不能声明 `pop: true`）。 */
async function leaseKey(secrets: SessionKeySecrets): Promise<PopLease | null> {
  if (!secrets.sessKey) return null;
  await loadPopState();
  const id = popKeyId(secrets.sessPk);
  let entry = popKeys.get(id);
  if (!entry) {
    entry = {
      key: secrets.sessKey,
      sessPk: new Uint8Array(secrets.sessPk),
      leases: 0,
      persisted: Promise.resolve(false),
    };
    popKeys.set(id, entry);
    entry.persisted = persistPopState();
  }
  entry.leases += 1;
  const lease = { id, epoch: popEpoch() };
  if (await entry.persisted) return lease;
  release(lease);
  return null;
}

async function bindNode(nodeId: string, lease: PopLease): Promise<void> {
  const entry = popKeys.get(lease.id);
  if (lease.epoch !== popEpoch() || !entry) return;
  popNodes.set(nodeId, { pk: lease.id, expiresAt: Date.now() + POP_SESSION_HARD_TTL_MS });
  entry.leases -= 1;
  dropUnusedKeys();
  await persistPopState();
  await notifyPopNodes(nodeId);
}

/**
 * 登录某 node：钥能持久化就声明 `pop: true`，登录成功后把该 node 绑到这把钥上
 * （此后对它的请求逐个签名、导航凭证定时续期）。登录抛错或失败都不改任何已有状态。
 */
export async function loginWithPop(
  api: AuthApi,
  nodeId: string,
  body: AuthLoginRequest,
  secrets: SessionKeySecrets
): Promise<LoginResult> {
  const lease = await leaseKey(secrets);
  if (!lease) return api.login(nodeId, body);
  let result: LoginResult;
  try {
    result = await api.login(nodeId, { ...body, pop: true });
  } catch (err) {
    release(lease);
    throw err;
  }
  if (result.ok) await bindNode(nodeId, lease);
  else release(lease);
  return result;
}
