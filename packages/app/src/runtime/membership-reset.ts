import { MeshMembershipStore } from '../../../../apps/gateway/src/auth/mesh-membership-store';
import { type TmexRoleName, roleNameFromFlags } from '../lib/roles';
import {
  SetupError,
  type SetupServiceDeps,
  patchOwnedEnvKeys,
  withSetupTransition,
} from './setup-service';

export type MeshRoleName = Exclude<TmexRoleName, 'standalone'>;

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

async function writeStandaloneEnv(deps: SetupServiceDeps): Promise<void> {
  if (!deps.envPath) {
    process.env.TMEX_ROLES = STANDALONE_ENV.TMEX_ROLES;
    process.env.TMEX_HUB_URL = STANDALONE_ENV.TMEX_HUB_URL;
    process.env.TMEX_HUB_PUBLIC_URL = STANDALONE_ENV.TMEX_HUB_PUBLIC_URL;
    return;
  }
  await patchOwnedEnvKeys(deps, { ...STANDALONE_ENV });
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
    if (fromRole === 'standalone') {
      throw new SetupError('not_member', 'not a mesh member', 400);
    }
    if (input.expectedRole !== fromRole) {
      throw new SetupError(
        'role_mismatch',
        `current role is ${fromRole}, expected ${input.expectedRole}`,
        409
      );
    }
    await quiesceBestEffort(deps);
    new MeshMembershipStore(deps.auth.db).clearAll();
    await writeStandaloneEnv(deps);
    return { ok: true as const, fromRole, restarting: true as const };
  });
}
