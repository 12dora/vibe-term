export {
  getBaseVersion,
  getDisplayVersion,
  getInstallInfo,
  getSystemInfo,
  canSelfUpdate,
  getManagementMode,
  getUpdateOwner,
  isManagedExternally,
  lockManagedRuntime,
  MANAGED_EXTERNALLY,
  resetManagedRuntimeForTests,
} from './info-public';

// 开源默认导出：自更新实现。managed compile 不得静态依赖本 barrel 的这两项。
export { checkForUpdate } from './update-check';
export { upgradeController } from './upgrade';
