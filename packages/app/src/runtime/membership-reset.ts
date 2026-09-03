import { MeshMembershipStore } from '../../../../apps/gateway/src/auth/mesh-membership-store';
import { resolveEnvWriteTarget, stringifyEnv } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { type TmexRoleName, roleNameFromFlags } from '../lib/roles';
import {
  SetupError,
  type SetupServiceDeps,
  newStagedEnvPath,
  promoteStagedEnv,
  readExistingEnv,
  removeStagedEnv,
  withSetupTransition,
  wrapJoinEnvWriteError,
  writeStagedEnv,
} from './setup-service';

/**
 * 能「退出 mesh」的角色：必须带 node 才有成员身份。
 * 纯 `relay` 只是替别的租户转发，本机没有用户/证书/密钥日志，没有可退的成员身份。
 */
export type MeshRoleName = Exclude<TmexRoleName, 'standalone' | 'relay'>;

export function isLeavableRoleName(value: unknown): value is MeshRoleName {
  return value === 'node' || value === 'hub,node' || value === 'relay,node';
}

export type LeaveMeshInput = {
  expectedRole: MeshRoleName;
};

export type LeaveMeshResult = {
  ok: true;
  fromRole: MeshRoleName;
  restarting: true;
};

const STANDALONE_ENV = {
  TMEX_ROLES: 'standalone',
  TMEX_HUB_URL: '',
  TMEX_HUB_PUBLIC_URL: '',
} as const;

type StagedStandalone = {
  stagedPath: string | null;
  envTarget: string | null;
};

function applyStandaloneProcessEnv(): void {
  process.env.TMEX_ROLES = STANDALONE_ENV.TMEX_ROLES;
  process.env.TMEX_HUB_URL = STANDALONE_ENV.TMEX_HUB_URL;
  process.env.TMEX_HUB_PUBLIC_URL = STANDALONE_ENV.TMEX_HUB_PUBLIC_URL;
}

async function stageStandaloneEnv(deps: SetupServiceDeps): Promise<StagedStandalone> {
  if (!deps.envPath) {
    return { stagedPath: null, envTarget: null };
  }
  let envTarget: string;
  try {
    envTarget = await resolveEnvWriteTarget(deps.envPath);
  } catch (error) {
    throw wrapJoinEnvWriteError(error);
  }
  const stagedPath = newStagedEnvPath(envTarget);
  try {
    await withEnvLock(async () => {
      const existing = await readExistingEnv(deps);
      await writeStagedEnv(
        deps,
        stagedPath,
        stringifyEnv({
          ...existing,
          ...STANDALONE_ENV,
        })
      );
    });
  } catch (error) {
    await removeStagedEnv(deps, stagedPath);
    throw wrapJoinEnvWriteError(error);
  }
  return { stagedPath, envTarget };
}

async function promoteStandaloneEnv(
  deps: SetupServiceDeps,
  staged: StagedStandalone
): Promise<void> {
  if (!staged.stagedPath || !staged.envTarget) {
    applyStandaloneProcessEnv();
    return;
  }
  const stagedPath = staged.stagedPath;
  const envTarget = staged.envTarget;
  try {
    await withEnvLock(async () => {
      await promoteStagedEnv(deps, stagedPath, envTarget);
    });
  } catch (error) {
    await removeStagedEnv(deps, stagedPath);
    throw wrapJoinEnvWriteError(error);
  }
}

async function quiesceBestEffort(deps: SetupServiceDeps): Promise<void> {
  try {
    await deps.quiesceMesh?.();
  } catch {
    // best-effort: restart will drop in-memory uplink/hub anyway
  }
}

export async function leaveMesh(
  input: LeaveMeshInput,
  deps: SetupServiceDeps
): Promise<LeaveMeshResult> {
  return await withSetupTransition(deps, async () => {
    const fromRole = roleNameFromFlags(deps.roles);
    if (!isLeavableRoleName(fromRole)) {
      throw new SetupError('not_member', `${fromRole} has no mesh membership to leave`, 400);
    }
    if (input.expectedRole !== fromRole) {
      throw new SetupError(
        'role_mismatch',
        `current role is ${fromRole}, expected ${input.expectedRole}`,
        409
      );
    }
    const staged = await stageStandaloneEnv(deps);
    try {
      await quiesceBestEffort(deps);
      new MeshMembershipStore(deps.auth.db).clearAll();
    } catch (error) {
      await removeStagedEnv(deps, staged.stagedPath);
      throw error;
    }
    await promoteStandaloneEnv(deps, staged);
    return { ok: true as const, fromRole, restarting: true as const };
  });
}
