/**
 * Companion-managed Gateway 运行时门禁。
 *
 * 管理态由 managed entry 在进程启动最早阶段锁定；锁定后用户环境变量
 * 与 API 调用均不能改写 management_mode / update_owner，也不能触发自更新。
 */

export type ManagementMode = 'none' | 'app' | 'companion-cli';
export type UpdateOwner = 'self' | 'app' | 'companion';

export const MANAGED_EXTERNALLY = 'managed_externally' as const;

interface ManagedLock {
  managementMode: ManagementMode;
  updateOwner: UpdateOwner;
  locked: boolean;
}

const state: ManagedLock = {
  managementMode: 'none',
  updateOwner: 'self',
  locked: false,
};

function parseManagementMode(raw: string | undefined): ManagementMode {
  if (raw === 'app' || raw === 'companion-cli') return raw;
  return 'none';
}

function parseUpdateOwner(raw: string | undefined): UpdateOwner {
  if (raw === 'app' || raw === 'companion') return raw;
  return 'self';
}

/**
 * 读取当前 env 快照并锁定。锁定后再次调用无效（保持首次锁定值）。
 * managed entry 必须在 import 业务模块前调用。
 */
export function lockManagedRuntime(options?: {
  managementMode?: ManagementMode;
  updateOwner?: UpdateOwner;
}): ManagedLock {
  if (state.locked) {
    return { ...state };
  }

  const mode = options?.managementMode ?? parseManagementMode(process.env.TMEX_MANAGEMENT_MODE);
  let owner = options?.updateOwner ?? parseUpdateOwner(process.env.TMEX_UPDATE_OWNER);

  if (mode === 'app') {
    owner = 'app';
  } else if (mode === 'companion-cli') {
    owner = 'companion';
  } else {
    owner = 'self';
  }

  state.managementMode = mode;
  state.updateOwner = owner;
  state.locked = true;

  // 回写锁定值，使后续读取 env 的代码看到受控值；用户无法在锁定前再覆盖。
  process.env.TMEX_MANAGEMENT_MODE = mode;
  process.env.TMEX_UPDATE_OWNER = owner;

  return { ...state };
}

/** 测试专用：重置锁定（仅 NODE_ENV=test）。 */
export function resetManagedRuntimeForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetManagedRuntimeForTests is test-only');
  }
  state.managementMode = 'none';
  state.updateOwner = 'self';
  state.locked = false;
  Reflect.deleteProperty(process.env, 'TMEX_MANAGEMENT_MODE');
  Reflect.deleteProperty(process.env, 'TMEX_UPDATE_OWNER');
}

export function getManagementMode(): ManagementMode {
  if (!state.locked) {
    // 非 managed entry 默认路径：惰性读取但不锁定（保持开源默认行为）。
    return parseManagementMode(process.env.TMEX_MANAGEMENT_MODE);
  }
  return state.managementMode;
}

export function getUpdateOwner(): UpdateOwner {
  if (!state.locked) {
    return parseUpdateOwner(process.env.TMEX_UPDATE_OWNER);
  }
  return state.updateOwner;
}

export function isManagedExternally(): boolean {
  return getManagementMode() !== 'none' || getUpdateOwner() !== 'self';
}

export function canSelfUpdate(installedViaCli: boolean, isProd: boolean): boolean {
  if (isManagedExternally()) return false;
  return isProd && installedViaCli;
}
