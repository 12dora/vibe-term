export const UPGRADE_FLAGS = new Set([
  'lang',
  'help',
  'h',
  'bun-path',
  'version',
  'install-dir',
  'repair',
  'keep-backup',
  'no-service',
  'apply-current-package',
  'txn',
  'service-name',
  'yes',
  'allow-missing-native',
  'allow-unverified',
]);

export const UPGRADE_PASSTHROUGH_FLAGS = [
  'install-dir',
  'service-name',
  'yes',
  'lang',
  'bun-path',
  'keep-backup',
  'no-service',
  'txn',
  'version',
  'allow-missing-native',
] as const;

export const UPGRADE_USAGE =
  'Usage: tmex upgrade [--version <version>] [--install-dir <path>] [--bun-path <path>] [--yes] [--lang <code>] [--repair] [--keep-backup] [--no-service] [--allow-missing-native] [--allow-unverified]';
