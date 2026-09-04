import { MeshMembershipStore } from '../../../../apps/gateway/src/auth/mesh-membership-store';
import { resolveEnvWriteTarget, stringifyEnv } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { type TmexRoleName, roleNameFromFlags } from '../lib/roles';
import type { SetupServiceDeps } from './setup-service';
import {
  SetupError,
  newStagedEnvPath,
  promoteStagedEnv,
  readExistingEnv,
  removeStagedEnv,
  withSetupTransition,
  wrapJoinEnvWriteError,
  writeStagedEnv,
} from './setup-shared';

/**
 * 能「退出 mesh」的角色：必须带 node 才有成员身份。
 * 纯 `relay` 只是替别的租户转发，本机没有用户/证书/密钥日志，没有可退的成员身份。
 */
export type MeshRoleName = Exclude<TmexRoleName, 'standalone' | 'relay'>;
export type LeaveTargetRole = 'standalone' | 'relay';

export function isLeavableRoleName(value: unknown): value is MeshRoleName {
  return value === 'node' || value === 'hub,node' || value === 'relay,node';
}

export function parseLeaveTargetRole(value: unknown): LeaveTargetRole {
  if (value === undefined || value === null || value === '') return 'standalone';
  if (value === 'standalone' || value === 'relay') return value;
  throw new SetupError('invalid_target', "targetRole must be 'standalone' or 'relay'", 400);
}

export type LeaveMeshInput = {
  expectedRole: MeshRoleName;
  targetRole?: LeaveTargetRole;
};

export type LeaveMeshResult = {
  ok: true;
  fromRole: MeshRoleName;
  targetRole: LeaveTargetRole;
  restarting: true;
};

const HUB_CLEARED_ENV = {
  TMEX_HUB_URL: '',
  TMEX_HUB_PUBLIC_URL: '',
} as const;

const RELAY_ENV_KEYS = ['TMEX_RELAY_PUBLIC_URL', 'TMEX_RELAY_ADMIN_TOKEN'] as const;

type StagedLeave = {
  stagedPath: string | null;
  envTarget: string | null;
  targetRole: LeaveTargetRole;
};

function omitRelayEnvKeys(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  for (const key of RELAY_ENV_KEYS) delete next[key];
  return next;
}

function applyLeaveProcessEnv(targetRole: LeaveTargetRole): void {
  process.env.TMEX_ROLES = targetRole === 'relay' ? 'relay' : 'standalone';
  process.env.TMEX_HUB_URL = HUB_CLEARED_ENV.TMEX_HUB_URL;
  process.env.TMEX_HUB_PUBLIC_URL = HUB_CLEARED_ENV.TMEX_HUB_PUBLIC_URL;
  if (targetRole === 'standalone') {
    for (const key of RELAY_ENV_KEYS) delete process.env[key];
  }
}

function leaveEnvPatch(
  existing: Record<string, string>,
  targetRole: LeaveTargetRole
): Record<string, string> {
  const next = {
    ...existing,
    ...HUB_CLEARED_ENV,
    TMEX_ROLES: targetRole === 'relay' ? 'relay' : 'standalone',
  };
  return targetRole === 'standalone' ? omitRelayEnvKeys(next) : next;
}

async function stageLeaveEnv(
  deps: SetupServiceDeps,
  targetRole: LeaveTargetRole
): Promise<StagedLeave> {
  if (!deps.envPath) {
    return { stagedPath: null, envTarget: null, targetRole };
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
      await writeStagedEnv(deps, stagedPath, stringifyEnv(leaveEnvPatch(existing, targetRole)));
    });
  } catch (error) {
    await removeStagedEnv(deps, stagedPath);
    throw wrapJoinEnvWriteError(error);
  }
  return { stagedPath, envTarget, targetRole };
}

async function promoteLeaveEnv(deps: SetupServiceDeps, staged: StagedLeave): Promise<void> {
  if (!staged.stagedPath || !staged.envTarget) {
    applyLeaveProcessEnv(staged.targetRole);
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

function clearMembershipForTarget(store: MeshMembershipStore, targetRole: LeaveTargetRole): void {
  if (targetRole === 'relay') {
    store.clearMeshMembership();
    return;
  }
  store.clearAll();
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
    const targetRole = parseLeaveTargetRole(input.targetRole);
    if (targetRole === 'relay' && fromRole !== 'relay,node') {
      throw new SetupError(
        'invalid_target',
        'only relay,node can leave to relay; other roles must leave to standalone then setup relay',
        400
      );
    }
    const staged = await stageLeaveEnv(deps, targetRole);
    try {
      await quiesceBestEffort(deps);
      clearMembershipForTarget(new MeshMembershipStore(deps.auth.db), targetRole);
    } catch (error) {
      await removeStagedEnv(deps, staged.stagedPath);
      throw error;
    }
    await promoteLeaveEnv(deps, staged);
    return { ok: true as const, fromRole, targetRole, restarting: true as const };
  });
}
