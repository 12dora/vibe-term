import { PROCESS_STARTED_AT } from '../../../../apps/gateway/src/api/system-routes';
import { config as gatewayConfig } from '../../../../apps/gateway/src/config';
import { clientIpFromRequest } from '../../../../apps/gateway/src/mesh/client-ip';
import { type RelayRuntime, createRelayRuntime } from '../../../../apps/gateway/src/relay';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { getBaseVersion } from '../../../../apps/gateway/src/system/version';
import { readNodeEnv } from '../../../../packages/shared/src/env/load-env';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import type { TmexRoles } from '../lib/roles';
import type { LocalRouteDeps } from './local-routes';
import { resolveSetupEnvPath } from './setup-service';

/** production 才把首启生成的中继管理令牌写回 app.env；dev/test 只打印一次。 */
async function patchRelayEnv(patch: Record<string, string>): Promise<void> {
  const envPath = resolveSetupEnvPath();
  await withEnvLock(async () => {
    let existing: Record<string, string> = {};
    try {
      existing = await readEnvFile(envPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeEnvFile(envPath, { ...existing, ...patch });
  });
}

function relayTurnConfig(): { url: string; username: string; credential: string } | null {
  const { turnUrl, turnUsername, turnCredential } = gatewayConfig;
  if (!turnUrl || !turnUsername || !turnCredential) return null;
  return { url: turnUrl, username: turnUsername, credential: turnCredential };
}

/** `relay` 角色的运行时；只在 `TMEX_ROLES` 含 relay 时创建，缺 public url 直接报配置错误。 */
export function createAssembledRelay(input: {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  routeDeps: LocalRouteDeps;
}): Promise<RelayRuntime> | null {
  if (!input.roles.relay) return null;
  // gateway config 是模块加载时的 env 快照；这里按运行时 env 优先，便于同进程内多实例测试
  const publicUrl = process.env.TMEX_RELAY_PUBLIC_URL?.trim() || gatewayConfig.relayPublicUrl;
  if (!publicUrl) {
    throw new Error('TMEX_RELAY_PUBLIC_URL is required when TMEX_ROLES includes relay');
  }
  return createRelayRuntime({
    db: input.gateway.db,
    config: {
      publicUrl,
      stun: gatewayConfig.stunServers,
      turn: relayTurnConfig(),
      adminToken: process.env.TMEX_RELAY_ADMIN_TOKEN?.trim() || gatewayConfig.relayAdminToken,
    },
    version: getBaseVersion(),
    startedAt: PROCESS_STARTED_AT,
    ...(input.roles.node
      ? { isLocalUserAuthenticated: (req: Request) => input.routeDeps.authenticate(req).ok }
      : {}),
    ...(readNodeEnv() === 'production' ? { patchEnv: patchRelayEnv } : {}),
    // 反代后面 socket IP 全是代理自己：限速必须按 trusted-proxy 解析出的真实客户端 IP
    clientIp: (req: Request) => clientIpFromRequest(req) ?? '',
  }).then((runtime) => {
    input.routeDeps.relayStatus = async () => runtime.snapshotForLocalStatus();
    return runtime;
  });
}
